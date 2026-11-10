/**
 * Klipbod — toolbar popup.
 *
 * Reads the history from chrome.storage.local on open, renders one card per
 * clip, and handles re-copying, deleting a single clip and clearing everything.
 * All user-provided content is inserted with textContent / attribute APIs, never
 * with innerHTML.
 *
 * The popup is re-rendered from storage whenever chrome.storage.onChanged fires
 * (the background worker writes there), so it also stays correct while open.
 */

import {
  KEYS,
  LIMITS,
  MESSAGE,
  TARGET,
  describeError,
  isHistoryKey,
  keysForClip,
  payloadKey,
  readHistoryIndex,
} from './shared.js';

/** The quota Chrome gives chrome.storage.local: 10 MiB. */
const QUOTA_BYTES = 10 * 1024 * 1024;
/** How long the "Copied" confirmation stays on a button. */
const COPIED_FEEDBACK_MS = 1400;
/** How long the "Clear all" confirmation stays open before it is dropped. */
const CONFIRM_TIMEOUT_MS = 8000;
/** Relative timestamps are refreshed on this interval. */
const CLOCK_INTERVAL_MS = 30_000;
/** How much clip content the popup loads up front from a very large history. */
const LOAD_BUDGET = 4 * 1024 * 1024;
/** Storage change bursts (a single copy writes two keys) are coalesced with this delay. */
const REFRESH_DELAY_MS = 120;
/** Above this share of the quota the storage meter turns into a warning. */
const HIGH_USAGE_RATIO = 0.75;
/** Longer text is stored in full but only a preview is put in the DOM. */
const TEXT_PREVIEW_CHARS = 4000;

/** @typedef {import('./shared.js').ClipRecord} ClipRecord */

/* -------------------------------------------------------------------------- */
/* Element lookup                                                             */
/* -------------------------------------------------------------------------- */

/**
 * @template T
 * @param {string} id
 * @returns {T}
 */
function required(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`The popup is missing its #${id} element.`);
  return /** @type {T} */ (element);
}

const dom = {
  status: required('status'),
  statusText: required('status-text'),
  clearAll: required('clear-all'),
  clearConfirm: required('clear-confirm'),
  clearConfirmText: required('clear-confirm-text'),
  clearCancel: required('clear-cancel'),
  clearConfirmYes: required('clear-confirm-yes'),
  meter: required('meter'),
  countLabel: required('count-label'),
  storageLabel: required('storage-label'),
  storageBar: required('storage-bar'),
  notice: required('notice'),
  noticeText: required('notice-text'),
  noticeDismiss: required('notice-dismiss'),
  stateLoading: required('state-loading'),
  stateEmpty: required('state-empty'),
  feed: required('feed'),
  main: /** @type {HTMLElement} */ (document.querySelector('.main')),
  template: required('card-template'),
};

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

/** Clip metadata, newest first. @type {ClipRecord[]} */
let records = [];
/** Clip contents by payload key. @type {Map<string, string>} */
let payloads = new Map();
/** Card elements by clip id, kept in sync with the DOM. @type {Map<string, HTMLLIElement>} */
let cards = new Map();

let loaded = false;
let refreshTimer = 0;
let refreshInFlight = false;
let refreshAgain = false;
let lastRefreshAt = 0;
let confirmTimer = 0;
let clockTimer = 0;

/** Image thumbnails are only decoded once their card is scrolled into view. */
const thumbnailObserver =
  'IntersectionObserver' in window
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const image = /** @type {HTMLImageElement} */ (entry.target);
            const payload = payloads.get(image.dataset.payloadKey ?? '');
            if (payload) image.src = payload;
            thumbnailObserver?.unobserve(image);
          }
        },
        { root: dom.main, rootMargin: '200px 0px' },
      )
    : null;

/* -------------------------------------------------------------------------- */
/* Start                                                                      */
/* -------------------------------------------------------------------------- */

dom.feed.addEventListener('click', onFeedClick);
dom.clearAll.addEventListener('click', () => showClearConfirm());
dom.clearCancel.addEventListener('click', () => hideClearConfirm());
dom.clearConfirmYes.addEventListener('click', () => void clearHistory());
dom.noticeDismiss.addEventListener('click', () => void dismissNotice());
chrome.storage.onChanged.addListener(onStorageChanged);

window.addEventListener('pagehide', () => {
  thumbnailObserver?.disconnect();
  window.clearInterval(clockTimer);
  window.clearTimeout(refreshTimer);
  window.clearTimeout(confirmTimer);
});

clockTimer = window.setInterval(() => {
  updateTimestamps();
  if (dom.clearConfirm.hidden === false && Date.now() > confirmDeadline) hideClearConfirm();
}, CLOCK_INTERVAL_MS);

void refresh({ initial: true }).then(() => {
  // Kick the background worker: this starts the clipboard reader if it is not
  // running and makes it look at the clipboard once, right now.
  void syncWithWorker();
  updateTimestamps();
});

/* -------------------------------------------------------------------------- */
/* Loading and rendering                                                      */
/* -------------------------------------------------------------------------- */

/**
 * @param {{initial?: boolean}} [options]
 */
async function refresh(options = {}) {
  if (refreshInFlight) {
    refreshAgain = true;
    return;
  }
  refreshInFlight = true;
  lastRefreshAt = Date.now();

  try {
    const { records: stored, garbage } = await readHistoryIndex();

    /** @type {string[]} */
    const payloadKeys = stored.map(payloadKey);
    /** @type {Record<string, unknown>} */
    const values = await fetchPayloads(payloadKeys);

    payloads = new Map();
    for (const key of payloadKeys) {
      const value = values[key];
      if (typeof value === 'string') payloads.set(key, value);
    }

    // A clip whose content vanished is not usable; drop its record as well.
    /** @type {ClipRecord[]} */
    const usable = [];
    /** @type {string[]} */
    const orphaned = [...garbage];
    for (const record of stored) {
      if (payloads.has(payloadKey(record))) usable.push(record);
      else orphaned.push(...keysForClip(record.id));
    }

    records = usable;
    render();

    await Promise.all([updateUsage(), showStoredNotice()]);

    if (orphaned.length > 0) {
      // Tidy up leftovers of an interrupted write; the worker does the same when
      // it next saves something.
      chrome.storage.local.remove(orphaned).catch((error) => {
        console.warn('[Klipbod] Could not remove orphaned storage entries:', error);
      });
    }

    loaded = true;
    if (options.initial) {
      dom.stateLoading.hidden = true;
      render();
    }
  } catch (error) {
    console.error('[Klipbod] Could not load the clipboard history:', error);
    dom.stateLoading.hidden = true;
    if (records.length === 0) {
      dom.stateEmpty.hidden = true;
      dom.feed.hidden = true;
    }
    showNotice(`Klipbod could not read its saved clips. (${describeError(error)})`);
  } finally {
    refreshInFlight = false;
    if (refreshAgain) {
      refreshAgain = false;
      scheduleRefresh();
    }
  }
}

/**
 * Reads clip contents. When the history is large (close to the 10 MB quota) the
 * text is fetched in order until most of the space is accounted for, so opening
 * the popup never copies all 10 MB into memory; any clip that is still missing
 * is fetched one by one as soon as its card needs it.
 *
 * @param {string[]} keys
 * @returns {Promise<Record<string, unknown>>}
 */
async function fetchPayloads(keys) {
  if (keys.length === 0) return {};

  let total = 0;
  try {
    total = await chrome.storage.local.getBytesInUse(keys);
  } catch (error) {
    console.warn('[Klipbod] Could not measure the clip contents:', error);
  }
  if (total <= LOAD_BUDGET) return chrome.storage.local.get(keys);

  /** @type {Record<string, unknown>} */
  const values = {};
  let fetched = 0;
  for (const key of keys) {
    const batch = await chrome.storage.local.get(key);
    const value = batch[key];
    if (typeof value === 'string') {
      values[key] = value;
      fetched += usageOf(key, value);
    }
    if (fetched >= LOAD_BUDGET) break;
  }
  return values;
}

/** @param {string} key @param {unknown} value */
function usageOf(key, value) {
  const json = JSON.stringify(value);
  return key.length + json.length + (json.match(/</g)?.length ?? 0) * 5;
}

function scheduleRefresh() {
  window.clearTimeout(refreshTimer);
  // Never hammer storage if writes keep arriving; 120 ms is invisible to users.
  const wait = Math.max(REFRESH_DELAY_MS, lastRefreshAt + REFRESH_DELAY_MS - Date.now());
  refreshTimer = window.setTimeout(() => void refresh(), wait);
}

/** @param {Record<string, chrome.storage.StorageChange>} changes */
function onStorageChanged(changes, areaName) {
  if (areaName !== 'local') return;

  if (Object.hasOwn(changes, KEYS.NOTICE)) {
    const value = changes[KEYS.NOTICE].newValue;
    if (value && typeof value.message === 'string') showNotice(value.message);
    else hideNotice();
  }

  const historyChanged = Object.keys(changes).some(
    (key) => key === KEYS.STATE || key.startsWith(KEYS.CLIP_PREFIX) || key.startsWith(KEYS.TEXT_PREFIX) || key.startsWith(KEYS.IMAGE_PREFIX),
  );
  if (historyChanged) scheduleRefresh();
}

/** Renders the feed from `records`, reusing cards that are already on screen. */
function render() {
  const hasClips = records.length > 0;
  dom.stateLoading.hidden = true;
  dom.feed.hidden = !hasClips;
  dom.stateEmpty.hidden = hasClips || !loaded;
  dom.clearAll.hidden = !hasClips;
  dom.meter.hidden = !hasClips;
  if (!hasClips) hideClearConfirm();

  const wanted = new Set(records.map((record) => record.id));
  for (const [id, card] of cards) {
    if (wanted.has(id)) continue;
    card.remove();
    cards.delete(id);
  }

  let cursor = dom.feed.firstElementChild;
  for (const record of records) {
    let card = cards.get(record.id);
    if (!card) {
      card = createCard(record);
      cards.set(record.id, card);
      dom.feed.insertBefore(card, cursor);
    } else if (card !== cursor) {
      dom.feed.insertBefore(card, cursor);
    }
    cursor = card.nextElementSibling;
    fillCard(card, record);
  }
}

/**
 * @param {ClipRecord} record
 * @returns {HTMLLIElement}
 */
function createCard(record) {
  const fragment = dom.template.content.cloneNode(true);
  const card = /** @type {HTMLLIElement} */ (fragment.firstElementChild);
  card.dataset.id = record.id;
  card.classList.add(record.type === 'image' ? 'card--image' : 'card--text');

  const image = /** @type {HTMLImageElement} */ (card.querySelector('.card__image'));
  image.addEventListener('error', () => {
    image.hidden = true;
    const caption = /** @type {HTMLElement} */ (card.querySelector('.card__caption'));
    caption.textContent = 'This image could not be displayed.';
  });
  // The card is also a list item for assistive technology: give it a name.
  card.setAttribute('aria-label', record.type === 'image' ? 'Image clip' : 'Text clip');
  return card;
}

/**
 * Fills a card with the current state of a clip. Runs on every render, so it
 * only touches what can have changed.
 * @param {HTMLLIElement} card
 * @param {ClipRecord} record
 */
function fillCard(card, record) {
  const isImage = record.type === 'image';
  const badgeLabel = /** @type {HTMLElement} */ (card.querySelector('.badge__label'));
  if (badgeLabel.textContent !== (isImage ? 'Image' : 'Text')) {
    badgeLabel.textContent = isImage ? 'Image' : 'Text';
    card.classList.toggle('card--image', isImage);
    card.classList.toggle('card--text', !isImage);
  }

  const time = /** @type {HTMLTimeElement} */ (card.querySelector('.card__time'));
  if (time.dataset.copiedAt !== String(record.copiedAt)) {
    time.dataset.copiedAt = String(record.copiedAt);
    time.dateTime = new Date(record.copiedAt).toISOString();
    time.title = new Date(record.copiedAt).toLocaleString();
    time.textContent = formatRelative(record.copiedAt);
  }

  const text = /** @type {HTMLElement} */ (card.querySelector('.card__text'));
  const figure = /** @type {HTMLElement} */ (card.querySelector('.card__figure'));
  const payload = payloads.get(payloadKey(record)) ?? '';

  if (isImage) {
    text.hidden = true;
    text.textContent = '';
    figure.hidden = false;

    const image = /** @type {HTMLImageElement} */ (card.querySelector('.card__image'));
    image.hidden = false;
    image.alt = `Clipboard image, ${record.width} by ${record.height} pixels`;
    image.dataset.payloadKey = payloadKey(record);
    if (!image.getAttribute('src')) {
      // Defer decoding until the thumbnail is actually near the viewport.
      if (thumbnailObserver) thumbnailObserver.observe(image);
      else if (payload) image.src = payload;
    }

    const caption = /** @type {HTMLElement} */ (card.querySelector('.card__caption'));
    caption.textContent = describeImage(record);
  } else {
    text.hidden = false;
    figure.hidden = true;

    // Only a preview goes into the DOM: a clip can hold 500k characters and the
    // card shows six lines of it anyway. The full text is always what gets copied.
    const preview =
      payload.length > TEXT_PREVIEW_CHARS ? `${payload.slice(0, TEXT_PREVIEW_CHARS)}…` : payload;
    if (text.dataset.payloadKey !== payloadKey(record)) {
      text.textContent = preview;
      text.dataset.payloadKey = payloadKey(record);
      text.title = payload.length > TEXT_PREVIEW_CHARS ? 'Showing the start of a long clip' : '';
      if (looksLikeCode(payload)) text.dataset.kind = 'code';
      else delete text.dataset.kind;
    }
    const caption = /** @type {HTMLElement} */ (card.querySelector('.card__caption'));
    caption.textContent = '';
  }

  const deleteButton = /** @type {HTMLButtonElement} */ (card.querySelector('[data-action="delete"]'));
  const label = isImage ? 'Delete this image' : `Delete this clip: ${summarise(record, payload)}`;
  if (deleteButton.getAttribute('aria-label') !== label) deleteButton.setAttribute('aria-label', label);

  if (!payload) showCardError(card, 'Its content is missing from storage.');
}

/** @param {ClipRecord} record @param {string} payload */
function summarise(record, payload) {
  if (record.type === 'image') return `${record.width} × ${record.height} image`;
  const single = payload.replace(/\s+/g, ' ').trim();
  return single.length > 60 ? `${single.slice(0, 60)}…` : single || 'empty';
}

/** @param {ClipRecord} record */
function describeImage(record) {
  const parts = [`${record.width} × ${record.height}`];
  if (typeof record.bytes === 'number') parts.push(formatBytes(record.bytes));
  if (record.resizedFrom) {
    parts.push(`scaled down from ${record.resizedFrom.width} × ${record.resizedFrom.height}`);
  }
  return parts.join(' · ');
}

/**
 * A rough check for monospace-worthy content. Presentation only: plain text is
 * always stored and shown either way.
 * @param {string} text
 */
function looksLikeCode(text) {
  if (!text.includes('\n')) return false;
  return /(^|\n)\s*(?:const|let|var|function|class|import|export|def|return|if|for|while|public|private|#include)\b|=>|[{}];?\s*$/m.test(
    text,
  );
}

function updateTimestamps() {
  for (const card of cards.values()) {
    const time = /** @type {HTMLTimeElement} */ (card.querySelector('.card__time'));
    const copiedAt = Number(time.dataset.copiedAt);
    if (Number.isFinite(copiedAt) && copiedAt > 0) time.textContent = formatRelative(copiedAt);
  }
}

/** @param {number} timestamp */
function formatRelative(timestamp) {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 10) return 'Just now';
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

async function updateUsage() {
  dom.countLabel.textContent = `${records.length} of ${LIMITS.MAX_ITEMS} clips`;

  let bytes = 0;
  try {
    bytes = await chrome.storage.local.getBytesInUse(null);
  } catch (error) {
    console.warn('[Klipbod] Could not measure storage usage:', error);
    dom.storageLabel.textContent = 'Usage unavailable';
    dom.storageBar.style.width = '0%';
    return;
  }

  const ratio = Math.min(1, bytes / QUOTA_BYTES);
  dom.storageLabel.textContent = `${formatBytes(bytes)} of 10 MB used`;
  // Keep a sliver of bar visible for tiny amounts, so it never looks broken.
  dom.storageBar.style.width = bytes > 0 ? `${Math.max(2, Math.round(ratio * 100))}%` : '0%';
  dom.storageBar.dataset.level = ratio >= HIGH_USAGE_RATIO ? 'high' : 'normal';
  dom.storageBar.setAttribute('role', 'progressbar');
  dom.storageBar.setAttribute('aria-valuemin', '0');
  dom.storageBar.setAttribute('aria-valuemax', '100');
  dom.storageBar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  dom.storageBar.setAttribute('aria-label', 'Storage used');
}

/** @param {number} bytes */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* -------------------------------------------------------------------------- */
/* Clipboard writes                                                           */
/* -------------------------------------------------------------------------- */

/** @param {MouseEvent} event */
function onFeedClick(event) {
  const button = /** @type {HTMLElement | null} */ (event.target)?.closest('[data-action]');
  if (!(button instanceof HTMLButtonElement)) return;

  const card = button.closest('.card');
  if (!(card instanceof HTMLLIElement)) return;

  const record = records.find((item) => item.id === card.dataset.id);
  if (!record) return;

  if (button.dataset.action === 'copy') {
    void copyClip(record, card, button);
  } else if (button.dataset.action === 'delete') {
    void deleteClip(record, card);
  }
}

/**
 * @param {ClipRecord} record
 * @param {HTMLLIElement} card
 * @param {HTMLButtonElement} button
 */
async function copyClip(record, card, button) {
  const payload = payloads.get(payloadKey(record));
  if (!payload) {
    showCardError(card, 'Its content is missing, so it cannot be copied.');
    return;
  }

  clearCardError(card);
  const label = /** @type {HTMLElement} */ (button.querySelector('.button__label'));
  const previous = label.textContent;
  button.disabled = true;
  label.textContent = 'Copying…';

  try {
    await writeClipboard(record, payload);
    button.dataset.copied = 'true';
    label.textContent = 'Copied';
    window.setTimeout(() => {
      button.dataset.copied = 'false';
      label.textContent = previous;
    }, COPIED_FEEDBACK_MS);
  } catch (error) {
    console.warn('[Klipbod] Could not copy the clip:', error);
    label.textContent = previous;
    showCardError(card, `Could not copy: ${describeError(error)}`);
  } finally {
    button.disabled = false;
  }
}

/**
 * @param {ClipRecord} record
 * @param {string} payload
 */
async function writeClipboard(record, payload) {
  if (record.type === 'text') {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(payload);
        return;
      } catch (error) {
        // A permission or focus problem; the legacy command is a good fallback.
        console.warn('[Klipbod] Clipboard API refused a text write, falling back:', error);
      }
    }
    legacyCopyText(payload);
    return;
  }

  if (typeof ClipboardItem !== 'function' || !navigator.clipboard?.write) {
    throw new Error('this browser cannot write images to the clipboard');
  }
  const blob = dataUrlToBlob(payload);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

/**
 * Fallback for environments where the asynchronous Clipboard API is rejected.
 * @param {string} text
 */
function legacyCopyText(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.className = 'offscreen-copy';
  document.body.append(area);
  area.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    area.remove();
  }
  if (!copied) throw new Error('Chrome blocked the clipboard write');
}

/** @param {string} dataUrl */
function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) throw new Error('the saved image is damaged');
  const header = dataUrl.slice(0, comma);
  const mime = /^data:([^;,]+)/.exec(header)?.[1] ?? 'image/png';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

/* -------------------------------------------------------------------------- */
/* Deleting                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * @param {ClipRecord} record
 * @param {HTMLLIElement} card
 */
async function deleteClip(record, card) {
  card.classList.add('card--leaving');
  try {
    await chrome.storage.local.remove(keysForClip(record.id));
    // The storage change listener re-renders; drop the card right away anyway so
    // the click feels instant.
    card.remove();
    cards.delete(record.id);
    records = records.filter((item) => item.id !== record.id);
    if (records.length === 0) {
      render();
      await updateUsage();
    }
  } catch (error) {
    console.error('[Klipbod] Could not delete the clip:', error);
    card.classList.remove('card--leaving');
    showCardError(card, `Could not delete: ${describeError(error)}`);
  }
}

let confirmDeadline = 0;

function showClearConfirm() {
  dom.clearConfirmText.textContent = `Delete all ${records.length} saved clips? This cannot be undone.`;
  dom.clearConfirm.hidden = false;
  dom.clearAll.setAttribute('aria-expanded', 'true');
  confirmDeadline = Date.now() + CONFIRM_TIMEOUT_MS;
  window.clearTimeout(confirmTimer);
  confirmTimer = window.setTimeout(() => hideClearConfirm(), CONFIRM_TIMEOUT_MS);
  dom.clearConfirmYes.focus();
}

function hideClearConfirm() {
  dom.clearConfirm.hidden = true;
  dom.clearAll.setAttribute('aria-expanded', 'false');
  window.clearTimeout(confirmTimer);
}

/**
 * Every storage key that belongs to the history, with or without a readable
 * index. Falls back to listing everything if the index cannot be read.
 * @returns {Promise<string[]>}
 */
async function collectHistoryKeys() {
  try {
    const { records: stored, garbage } = await readHistoryIndex();
    return [...stored.flatMap((record) => keysForClip(record.id)), ...garbage];
  } catch (error) {
    console.warn('[Klipbod] Could not read the index, clearing every history key:', error);
    const all = await chrome.storage.local.get(null);
    return Object.keys(all).filter((key) => isHistoryKey(key));
  }
}

async function clearHistory() {
  hideClearConfirm();

  try {
    const keys = await collectHistoryKeys();
    if (keys.length > 0) await chrome.storage.local.remove(keys);
    // The last-seen clipboard identity is kept on purpose: the clip that is
    // currently on the clipboard should not reappear one second after clearing.
    records = [];
    payloads = new Map();
    thumbnailObserver?.disconnect();
    cards = new Map();
    dom.feed.replaceChildren();
    render();
    await updateUsage();
  } catch (error) {
    console.error('[Klipbod] Could not clear the history:', error);
    showNotice(`Klipbod could not delete the history. (${describeError(error)})`);
  }
}

/* -------------------------------------------------------------------------- */
/* Notices and status                                                         */
/* -------------------------------------------------------------------------- */

/** @param {string} message */
function showNotice(message) {
  dom.noticeText.textContent = message;
  dom.notice.hidden = false;
}

function hideNotice() {
  dom.notice.hidden = true;
  dom.noticeText.textContent = '';
}

async function showStoredNotice() {
  try {
    const stored = await chrome.storage.local.get(KEYS.NOTICE);
    const notice = stored[KEYS.NOTICE];
    if (notice && typeof notice.message === 'string' && notice.message) showNotice(notice.message);
    else hideNotice();
  } catch (error) {
    console.warn('[Klipbod] Could not read the stored notice:', error);
  }
}

async function dismissNotice() {
  hideNotice();
  try {
    await chrome.storage.local.remove(KEYS.NOTICE);
  } catch (error) {
    console.warn('[Klipbod] Could not dismiss the notice:', error);
  }
}

/**
 * Asks the worker to make sure the reader is running. The reply also tells us
 * whether clipboard watching is actually working right now.
 */
async function syncWithWorker() {
  setStatus('starting', 'Checking the clipboard reader…');

  try {
    const reply = await chrome.runtime.sendMessage({ target: TARGET.WORKER, type: MESSAGE.SYNC });
    if (reply && reply.monitoring) {
      setStatus('active', 'Watching the clipboard');
    } else if (reply && typeof reply.error === 'string' && reply.error) {
      setStatus('error', 'Clipboard reader unavailable');
      showNotice(`Klipbod could not start reading the clipboard. (${reply.error})`);
    } else {
      setStatus('error', 'Clipboard reader unavailable');
    }
  } catch (error) {
    console.warn('[Klipbod] Could not reach the background worker:', error);
    setStatus('error', 'Background worker unavailable');
    showNotice(`Klipbod's background worker is not responding. (${describeError(error)})`);
  }
}

/**
 * @param {'starting' | 'active' | 'error' | 'stalled'} state
 * @param {string} text
 */
function setStatus(state, text) {
  dom.status.dataset.state = state;
  dom.statusText.textContent = text;
}

/**
 * Appends an error line to a card and, one day, removes it again.
 * @param {HTMLElement} card
 * @param {string} message
 */
function showCardError(card, message) {
  let error = /** @type {HTMLElement | null} */ (card.querySelector('.card__error'));
  if (!error) {
    error = document.createElement('p');
    error.className = 'card__error';
    error.setAttribute('role', 'alert');
    card.append(error);
  }
  error.textContent = message;
}

/** @param {HTMLElement} card */
function clearCardError(card) {
  card.querySelector('.card__error')?.remove();
}
