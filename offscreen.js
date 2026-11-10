/**
 * Klipbod — offscreen document.
 *
 * This page is never shown. Its only job is to look at the system clipboard,
 * which no other extension context can do: a service worker has no DOM, and the
 * popup only exists while it is open. The background worker creates this
 * document and forwards what it finds into the history.
 *
 * Why document.execCommand('paste') instead of navigator.clipboard.read():
 * the asynchronous Clipboard API requires a focused document, and an offscreen
 * document can never be focused. The legacy paste command only needs a focused
 * editable element and the clipboardRead permission, both of which we have.
 *
 * Storage is deliberately not touched here — chrome.storage does not exist in
 * offscreen documents. Everything is reported to the worker with
 * chrome.runtime.sendMessage and the worker decides what to keep.
 */

import { LIMITS, MESSAGE, PNG_DATA_URL_PREFIX, TARGET, describeError } from './shared.js';

/* -------------------------------------------------------------------------- */
/* Tuning                                                                     */
/* -------------------------------------------------------------------------- */

/** Shortest pause between two looks at the clipboard. */
const MIN_DELAY_MS = 1000;
/** Longest pause; used after an expensive poll so the page stays responsive. */
const MAX_DELAY_MS = 5000;
/** The pause scales with how long the last poll took, roughly 4% of one core. */
const DELAY_FACTOR = 25;

/** Clipboard images larger than this are refused before any decoding happens. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** Above this pixel count an image is identified by a bounded, rescaled copy. */
const MAX_PIXEL_AREA = 40_000_000;
/** Size of that bounded copy. */
const IDENTITY_AREA = 4_000_000;
/** How many times a too-large image may be shrunk before giving up. */
const MAX_DOWNSCALE_ATTEMPTS = 6;
/** Each attempt shrinks the long side by this factor. */
const DOWNSCALE_STEP = 0.7;
/** Images will not be shrunk below this on their long side. */
const MIN_SCALED_SIDE = 64;

/** @type {HTMLTextAreaElement} */
const sink = /** @type {HTMLTextAreaElement} */ (document.getElementById('clipboard-sink'));
const encoder = new TextEncoder();

/* -------------------------------------------------------------------------- */
/* Polling loop                                                               */
/* -------------------------------------------------------------------------- */

/** Identity of the last observation sent to the worker; null means "empty". */
/** @type {string | null | undefined} */
let lastSentIdentity;

/**
 * Cache of the last image seen, keyed by the bytes of the clipboard PNG.
 * Reading the same image again costs one hash instead of a decode.
 * @type {{
 *   byteHash: string,
 *   observation: {kind: 'image' | 'skipped', hash: string} & Record<string, unknown>,
 * } | null}
 */
let lastImage = null;

/** 'ok' or 'error': the last status reported to the worker. */
/** @type {string | null} */
let lastStatus = null;

let polling = false;
let pollAgain = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let timer = null;

/**
 * Asks the worker to look at the clipboard now, e.g. because the popup opened.
 * @returns {Promise<{ok: boolean, error?: string, pending?: boolean}>}
 */
function pollNow() {
  if (polling) {
    pollAgain = true;
    return Promise.resolve({ ok: true, pending: true });
  }
  return poll();
}

/**
 * One look at the clipboard: read, report, then schedule the next look.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function poll() {
  if (polling) {
    pollAgain = true;
    return { ok: true };
  }

  polling = true;
  const startedAt = performance.now();
  /** @type {{ok: boolean, error?: string}} */
  let result;

  try {
    await handleSnapshot(readClipboard());
    await reportStatus({ ok: true });
    result = { ok: true };
  } catch (error) {
    const message = describeError(error);
    console.warn('[Klipbod] Could not read the clipboard:', message);
    await reportStatus({ ok: false, error: message });
    result = { ok: false, error: message };
  } finally {
    polling = false;
    const elapsed = performance.now() - startedAt;
    if (pollAgain) {
      pollAgain = false;
      schedule(0);
    } else {
      schedule(Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.round(elapsed * DELAY_FACTOR))));
    }
  }

  return result;
}

/** @param {number} delay */
function schedule(delay) {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void poll();
  }, delay);
}

/* -------------------------------------------------------------------------- */
/* Reading the clipboard                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Reads the clipboard with the legacy paste command. Everything in the paste
 * event must be read synchronously: Chrome neutralises the clipboard data as
 * soon as the listener returns, and an image can only be turned into a File
 * while the event is still running.
 *
 * @returns {{text: string, imageFile: File | null}}
 */
function readClipboard() {
  if (typeof document.execCommand !== 'function') {
    throw new Error('This browser does not support reading the clipboard from an extension page.');
  }

  /** @type {{text: string, imageFile: File | null} | null} */
  let captured = null;

  /** @param {ClipboardEvent} event */
  const onPaste = (event) => {
    // Keep the text out of the textarea, and stop the default action too.
    event.preventDefault();
    event.stopImmediatePropagation();
    captured = extractClipboard(event.clipboardData);
  };

  window.addEventListener('paste', onPaste, true);
  let accepted;
  try {
    sink.value = '';
    sink.focus();
    accepted = document.execCommand('paste');
  } finally {
    window.removeEventListener('paste', onPaste, true);
  }

  if (accepted === false) {
    throw new Error('Chrome refused to read the clipboard (the paste command was rejected).');
  }
  return captured ?? { text: '', imageFile: null };
}

/**
 * Pulls text and the first PNG image out of a paste event.
 * @param {DataTransfer | null} data
 * @returns {{text: string, imageFile: File | null}}
 */
function extractClipboard(data) {
  if (!data) return { text: '', imageFile: null };

  let text = '';
  try {
    text = data.getData('text/plain') ?? '';
  } catch (error) {
    console.warn('[Klipbod] Could not read the clipboard text:', error);
  }

  /** @type {File | null} */
  let imageFile = null;
  try {
    for (const item of data.items) {
      if (item.kind !== 'file' || item.type !== 'image/png') continue;
      imageFile = item.getAsFile();
      if (imageFile && imageFile.size > 0) break;
      imageFile = null;
    }
  } catch (error) {
    console.warn('[Klipbod] Could not read the clipboard image:', error);
  }

  return { text, imageFile: imageFile && imageFile.size > 0 ? imageFile : null };
}

/* -------------------------------------------------------------------------- */
/* Turning clipboard contents into an observation                             */
/* -------------------------------------------------------------------------- */

/**
 * @param {{text: string, imageFile: File | null}} snapshot
 */
async function handleSnapshot(snapshot) {
  // Whitespace-only text is noise from select-all/drag operations, and an image
  // copied from a screenshot tool has no text at all. Real text wins over the
  // image when both are present (e.g. copying cells out of a spreadsheet).
  if (snapshot.text !== '' && snapshot.text.trim() !== '') {
    await handleText(snapshot.text);
    return;
  }
  if (snapshot.imageFile) {
    await handleImage(snapshot.imageFile);
    return;
  }
  await dispatch({ hash: null, observation: { kind: 'empty' } });
}

/** @param {string} text */
async function handleText(text) {
  // Newlines are normalised so that the same text copied from Windows and from
  // Linux is recognised as the same clip.
  const normalized = text.replace(/\r\n?/g, '\n');
  const hash = await sha256Hex(encoder.encode(normalized));

  if (text.length > LIMITS.MAX_TEXT_CHARS) {
    await dispatch({ hash, observation: { kind: 'skipped', hash, reason: 'text-too-large', chars: text.length } });
    return;
  }

  await dispatch({ hash, observation: { kind: 'text', hash, text } });
}

/** @param {File} file */
async function handleImage(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const byteHash = await sha256Hex(bytes);

  // Same bytes as last time: the picture on the clipboard has not changed since
  // the previous poll, so reuse everything that was computed for it.
  if (lastImage && lastImage.byteHash === byteHash) {
    await dispatch({ hash: lastImage.observation.hash, observation: lastImage.observation });
    return;
  }

  const observation = await analyseImage(bytes, byteHash);
  lastImage = { byteHash, observation };
  await dispatch({ hash: observation.hash, observation });
}

/**
 * @param {Uint8Array} bytes Raw PNG as found on the clipboard.
 * @param {string} byteHash SHA-256 of those bytes.
 * @returns {Promise<{kind: 'image', hash: string, storedHash?: string, dataUrl: string,
 *   width: number, height: number, resizedFrom?: {width: number, height: number}} |
 *   {kind: 'skipped', hash: string, reason: string, width?: number, height?: number}>}
 */
async function analyseImage(bytes, byteHash) {
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return { kind: 'skipped', hash: byteHash, reason: 'image-too-large' };
  }

  /** @type {ImageBitmap} */
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  } catch (error) {
    console.warn('[Klipbod] Could not decode a clipboard image:', error);
    return { kind: 'skipped', hash: byteHash, reason: 'image-unreadable' };
  }

  try {
    const width = bitmap.width;
    const height = bitmap.height;
    if (width <= 0 || height <= 0) {
      return { kind: 'skipped', hash: byteHash, reason: 'image-unreadable' };
    }

    const hash = await identityHashOf(bitmap, bytes);
    const dataUrl = PNG_DATA_URL_PREFIX + toBase64(bytes);

    if (dataUrl.length <= LIMITS.MAX_IMAGE_CHARS) {
      return { kind: 'image', hash, dataUrl, width, height };
    }

    const scaled = await downscale(bitmap, dataUrl.length);
    if (!scaled) {
      return { kind: 'skipped', hash, reason: 'image-too-large', width, height };
    }

    return {
      kind: 'image',
      hash,
      storedHash: scaled.storedHash,
      dataUrl: scaled.dataUrl,
      width: scaled.width,
      height: scaled.height,
      resizedFrom: { width, height },
    };
  } finally {
    bitmap.close();
  }
}

/**
 * Identity of the pixels on the clipboard. PNG bytes are not a usable identity:
 * Chromium re-encodes an image every time it is written to the clipboard, so the
 * bytes change while the picture stays exactly the same. Pixels do not change.
 *
 * Very large images are hashed from a bounded, rescaled copy so that hashing
 * cannot exhaust memory; that copy is deterministic for identical pixels, so
 * repeats are still recognised.
 *
 * @param {ImageBitmap} bitmap
 * @param {Uint8Array} bytes
 */
async function identityHashOf(bitmap, bytes) {
  const area = bitmap.width * bitmap.height;
  if (area <= MAX_PIXEL_AREA) return hashCanvasPixels(bitmap, bitmap.width, bitmap.height);

  const target = fitWithinArea(bitmap.width, bitmap.height, IDENTITY_AREA);
  const small = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
    resizeWidth: target.width,
    resizeHeight: target.height,
    resizeQuality: 'pixelated',
  });
  try {
    return await hashCanvasPixels(small, target.width, target.height);
  } finally {
    small.close();
  }
}

/**
 * Shrinks an image until its PNG fits in LIMITS.MAX_IMAGE_CHARS.
 *
 * @param {ImageBitmap} bitmap
 * @param {number} currentLength Length of the PNG data URL that was too long.
 * @returns {Promise<{dataUrl: string, width: number, height: number, storedHash: string} | null>}
 *   null when the image cannot be made small enough.
 */
async function downscale(bitmap, currentLength) {
  let scale = Math.min(0.95, Math.sqrt(LIMITS.MAX_IMAGE_CHARS / currentLength) * 0.9);
  if (!(scale > 0)) return null;

  for (let attempt = 0; attempt < MAX_DOWNSCALE_ATTEMPTS; attempt += 1) {
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    if (Math.max(width, height) < MIN_SCALED_SIDE) return null;

    /** @type {OffscreenCanvas} */
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const dataUrl = PNG_DATA_URL_PREFIX + (await blobToBase64(blob));

    if (dataUrl.length <= LIMITS.MAX_IMAGE_CHARS) {
      // Identity of what will end up in the history, so that copying the clip
      // back out of the popup is recognised as the same item. It is taken from
      // the encoded PNG itself: a decode/encode round trip can shift the colour
      // of semi-transparent pixels by one step.
      const storedHash = await hashEncodedImage(blob, width, height);
      return { dataUrl, width, height, storedHash };
    }

    scale *= DOWNSCALE_STEP;
  }

  return null;
}

/**
 * @param {Blob} blob
 * @param {number} width
 * @param {number} height
 */
async function hashEncodedImage(blob, width, height) {
  const decoded = await createImageBitmap(blob);
  try {
    return await hashCanvasPixels(decoded, width, height);
  } finally {
    decoded.close();
  }
}

/**
 * SHA-256 of the RGBA pixels of an image drawn onto a canvas of the given size.
 * @param {ImageBitmap} source
 * @param {number} width
 * @param {number} height
 */
async function hashCanvasPixels(source, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser did not provide a canvas to read the image with.');

  context.drawImage(source, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  return sha256Hex(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
}

/* -------------------------------------------------------------------------- */
/* Talking to the worker                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Sends an observation unless it is identical to the previous one. The worker
 * keeps its own copy of the last identity, so a missed or failed send is healed
 * by the next poll.
 *
 * @param {{hash: string | null, observation: Record<string, unknown>}} update
 */
async function dispatch({ hash, observation }) {
  if (hash === lastSentIdentity) return;

  try {
    const reply = await chrome.runtime.sendMessage({
      target: TARGET.WORKER,
      type: MESSAGE.CLIPBOARD_CHANGED,
      observation,
    });
    if (reply && reply.ok === false) {
      // The worker could not save it; leave the identity alone so the next poll
      // tries again instead of silently losing the clip.
      console.warn('[Klipbod] The worker could not save the clip:', reply.error);
      return;
    }
    lastSentIdentity = hash;
  } catch (error) {
    console.warn('[Klipbod] Could not reach the background worker:', describeError(error));
  }
}

/**
 * Tells the worker whether reading works, so the popup can explain a failure.
 * Only transitions are sent.
 * @param {{ok: boolean, error?: string}} status
 */
async function reportStatus(status) {
  const key = status.ok ? 'ok' : 'error';
  if (key === lastStatus) return;
  lastStatus = key;

  try {
    await chrome.runtime.sendMessage({
      target: TARGET.WORKER,
      type: MESSAGE.READER_STATUS,
      status,
    });
  } catch (error) {
    console.warn('[Klipbod] Could not report the reader status:', describeError(error));
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** @param {Uint8Array} bytes */
async function sha256Hex(bytes) {
  // A fresh copy, because digest() rejects views onto a SharedArrayBuffer and
  // some callers hand us subarrays of larger buffers.
  const view = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', view);
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string} Base64 without any prefix.
 */
function toBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * @param {Blob} blob
 * @returns {Promise<string>} Base64 without any prefix.
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the encoded image.'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      if (comma === -1) {
        reject(new Error('Could not read the encoded image.'));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Largest size with the same aspect ratio whose area fits in `maxArea`.
 * @param {number} width
 * @param {number} height
 * @param {number} maxArea
 */
function fitWithinArea(width, height, maxArea) {
  const scale = Math.sqrt(maxArea / (width * height));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

/* -------------------------------------------------------------------------- */
/* Start                                                                      */
/* -------------------------------------------------------------------------- */

// Registered synchronously, before the first poll: the worker starts driving
// this document as soon as createDocument() resolves.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || sender.id !== chrome.runtime.id) return false;
  if (message.target !== TARGET.READER || message.type !== MESSAGE.POLL_NOW) return false;

  pollNow().then(sendResponse, (error) => sendResponse({ ok: false, error: describeError(error) }));
  return true;
});

void poll();
