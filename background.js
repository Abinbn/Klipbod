/**
 * Klipbod — background service worker.
 *
 * A Manifest V3 service worker has no DOM and no access to the clipboard, so it
 * cannot watch the clipboard directly. Instead it owns an offscreen document
 * (offscreen.html) that polls the clipboard and reports every change here. The
 * worker then decides what to keep and writes it to chrome.storage.local:
 *
 *   - content identical to what was last seen is ignored;
 *   - content that is already in the history moves back to the top;
 *   - anything else becomes a new clip, after which the history is trimmed to
 *     LIMITS.MAX_ITEMS and, if Chrome's storage quota is hit, older clips are
 *     evicted until the new one fits.
 *
 * The worker is short-lived by design: Chrome stops it after ~30 idle seconds
 * and starts it again for the next message or alarm. Nothing important is kept
 * in module variables for that reason; all state lives in storage.
 */

import {
  KEYS,
  LIMITS,
  MESSAGE,
  NOTICE,
  PNG_DATA_URL_PREFIX,
  TARGET,
  clipKey,
  describeError,
  keysForClip,
  payloadKey,
  readHistoryIndex,
} from './shared.js';

/** @typedef {import('./shared.js').ClipRecord} ClipRecord */

/**
 * What the reader found on the clipboard.
 * @typedef {(
 *   {kind: 'empty'} |
 *   {kind: 'text', hash: string, text: string} |
 *   {kind: 'image', hash: string, storedHash?: string, dataUrl: string,
 *    width: number, height: number, resizedFrom?: {width: number, height: number}} |
 *   {kind: 'skipped', hash: string, reason: string, chars?: number, width?: number, height?: number}
 * )} Observation
 */

const READER_DOCUMENT = 'offscreen.html';
const WATCHDOG_ALARM = 'klipbod:watchdog';
const WATCHDOG_PERIOD_MINUTES = 1;
const MAX_IMAGE_DIMENSION = 65_535;
const MAX_HASH_LENGTH = 128;

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

// Listeners must be registered synchronously on every start of the worker,
// otherwise Chrome cannot wake it for the corresponding events.
chrome.runtime.onInstalled.addListener(() => {
  void startMonitoring();
});

chrome.runtime.onStartup.addListener(() => {
  void startMonitoring();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM) void startMonitoring();
});

chrome.runtime.onMessage.addListener(handleMessage);

// Covers every other way the worker can start, e.g. being re-enabled.
void startMonitoring();

/**
 * Makes sure the clipboard reader is running. Safe to call as often as needed.
 * @returns {Promise<{monitoring: boolean, error: string | null}>}
 */
async function startMonitoring() {
  try {
    await ensureWatchdog();
    await ensureReaderDocument();
    return { monitoring: true, error: null };
  } catch (error) {
    console.error('[Klipbod] Could not start clipboard monitoring:', error);
    return { monitoring: false, error: describeError(error) };
  }
}

/**
 * A periodic alarm that re-creates the reader if it ever goes away while the
 * worker is asleep. The alarm is only created when missing so that frequent
 * worker restarts do not keep postponing it.
 */
async function ensureWatchdog() {
  const existing = await chrome.alarms.get(WATCHDOG_ALARM);
  if (!existing) {
    await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MINUTES });
  }
}

/** @type {Promise<void> | null} */
let creatingReader = null;

async function ensureReaderDocument() {
  if (await hasReaderDocument()) return;

  // Chrome allows one offscreen document per extension, and several events can
  // ask for it at the same moment, so share a single in-flight request.
  if (!creatingReader) {
    creatingReader = chrome.offscreen
      .createDocument({
        url: READER_DOCUMENT,
        reasons: ['CLIPBOARD'],
        justification:
          'Read text and images from the clipboard so they can be saved to the local clipboard history.',
      })
      .catch((error) => {
        // Lost a race with another caller: the document exists, which is all we need.
        if (!/single offscreen document/i.test(describeError(error))) throw error;
      })
      .finally(() => {
        creatingReader = null;
      });
  }
  await creatingReader;
}

async function hasReaderDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(READER_DOCUMENT)],
  });
  return contexts.length > 0;
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * @param {any} message
 * @param {chrome.runtime.MessageSender} sender
 * @param {(response: unknown) => void} sendResponse
 * @returns {boolean} true when the response is sent asynchronously.
 */
function handleMessage(message, sender, sendResponse) {
  if (!message || message.target !== TARGET.WORKER || sender.id !== chrome.runtime.id) {
    return false;
  }

  /** @type {Promise<unknown>} */
  let work;
  switch (message.type) {
    case MESSAGE.CLIPBOARD_CHANGED:
      work = enqueue(() => saveObservation(message.observation));
      break;
    case MESSAGE.READER_STATUS:
      work = enqueue(() => saveReaderStatus(message.status));
      break;
    case MESSAGE.SYNC:
      work = syncNow();
      break;
    default:
      return false;
  }

  work.then(sendResponse, (error) => {
    console.error('[Klipbod] Unexpected failure while handling a message:', error);
    sendResponse({ ok: false, error: describeError(error) });
  });
  return true;
}

/** Tail of the write queue; see enqueue(). */
let queue = Promise.resolve();

/**
 * Runs storage-changing tasks one at a time. Each task reads the history and
 * then writes based on what it read, so two of them must never interleave.
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Handles the popup opening (or asking for a refresh): restarts monitoring if
 * needed and has the reader look at the clipboard right now, so the popup never
 * shows a history that is up to one polling interval out of date.
 */
async function syncNow() {
  const started = await startMonitoring();
  if (!started.monitoring) return { ok: true, monitoring: false, error: started.error };

  try {
    const reply = await chrome.runtime.sendMessage({
      target: TARGET.READER,
      type: MESSAGE.POLL_NOW,
    });
    if (reply && reply.ok === true) return { ok: true, monitoring: true, error: null };
    return {
      ok: true,
      monitoring: false,
      error: (reply && reply.error) || 'The clipboard reader did not respond.',
    };
  } catch (error) {
    return { ok: true, monitoring: false, error: describeError(error) };
  }
}

/**
 * Surfaces persistent clipboard read failures in the popup, and removes the
 * warning again once reading works.
 * @param {{ok?: boolean, error?: string} | undefined} status
 */
async function saveReaderStatus(status) {
  if (status && status.ok === true) {
    await clearNotice(NOTICE.CLIPBOARD_UNREADABLE);
  } else {
    const detail = status && typeof status.error === 'string' ? status.error : 'Unknown error';
    await setNotice(
      NOTICE.CLIPBOARD_UNREADABLE,
      `Klipbod cannot read the clipboard right now, so new copies are not being saved. (${detail})`,
    );
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Saving clips                                                               */
/* -------------------------------------------------------------------------- */

/**
 * @param {unknown} observation
 * @returns {Promise<{ok: boolean, outcome?: string, id?: string, error?: string}>}
 */
async function saveObservation(observation) {
  const problem = validateObservation(observation);
  if (problem) {
    console.warn('[Klipbod] Ignored a malformed clipboard update:', problem);
    return { ok: false, error: problem };
  }

  try {
    return await applyObservation(/** @type {Observation} */ (observation));
  } catch (error) {
    console.error('[Klipbod] Could not save the clip:', error);
    await setNotice(
      NOTICE.STORAGE_FAILED,
      `Klipbod could not save the latest copy. (${describeError(error)})`,
    );
    return { ok: false, error: describeError(error) };
  }
}

/** @param {Observation} observation */
async function applyObservation(observation) {
  const { records, garbage } = await readHistoryIndex();
  if (garbage.length > 0) await removeQuietly(garbage);

  const lastHash = await readLastHash();

  if (observation.kind === 'empty') {
    // Nothing storable on the clipboard (empty, or only formats Klipbod does not
    // keep). Forget the previous content so copying it again later counts as new.
    if (lastHash !== null) await chrome.storage.local.set({ [KEYS.STATE]: { lastHash: null } });
    return { ok: true, outcome: 'empty' };
  }

  // The same content as last time. This is how a clip the user deleted stays
  // deleted while it is still sitting on the clipboard, including across
  // browser restarts.
  if (observation.hash === lastHash) return { ok: true, outcome: 'unchanged' };

  const state = { [KEYS.STATE]: { lastHash: observation.hash } };

  if (observation.kind === 'skipped') {
    await setNotice(NOTICE.CLIP_SKIPPED, describeSkip(observation));
    try {
      await chrome.storage.local.set(state);
    } catch (error) {
      console.warn('[Klipbod] Could not remember a skipped clip:', error);
    }
    return { ok: true, outcome: 'skipped' };
  }

  const copiedAt = nextTimestamp(records);

  const existing = records.find((record) => record.hashes.includes(observation.hash));
  if (existing) {
    const others = records.filter((record) => record !== existing);
    await persist({ ...state, [clipKey(existing.id)]: { ...existing, copiedAt } }, others);
    return { ok: true, outcome: 'moved', id: existing.id };
  }

  const record = createRecord(observation, copiedAt);
  const content = observation.kind === 'image' ? observation.dataUrl : observation.text;
  const kept = await trimToLimit(records, LIMITS.MAX_ITEMS - 1);
  await persist({ ...state, [clipKey(record.id)]: record, [payloadKey(record)]: content }, kept);
  return { ok: true, outcome: 'added', id: record.id };
}

/**
 * @param {Extract<Observation, {kind: 'text' | 'image'}>} observation
 * @param {number} copiedAt
 * @returns {ClipRecord}
 */
function createRecord(observation, copiedAt) {
  const id = crypto.randomUUID();

  if (observation.kind === 'text') {
    return { id, type: 'text', copiedAt, hashes: [observation.hash], chars: observation.text.length };
  }

  /** @type {ClipRecord} */
  const record = {
    id,
    type: 'image',
    copiedAt,
    hashes: [observation.hash],
    width: observation.width,
    height: observation.height,
    bytes: decodedLength(observation.dataUrl),
  };
  if (observation.resizedFrom) {
    record.resizedFrom = {
      width: observation.resizedFrom.width,
      height: observation.resizedFrom.height,
    };
    // A scaled-down image has two identities: the original pixels (copying the
    // same source again) and the stored pixels (copying it back from the popup).
    if (observation.storedHash && observation.storedHash !== observation.hash) {
      record.hashes.push(observation.storedHash);
    }
  }
  return record;
}

/**
 * A timestamp that always sorts above every existing clip, even if the system
 * clock was moved backwards since the newest one was saved.
 * @param {ClipRecord[]} records Sorted newest first.
 */
function nextTimestamp(records) {
  const newest = records.length > 0 ? records[0].copiedAt : 0;
  return Math.max(Date.now(), newest + 1);
}

/**
 * Enforces the item limit by deleting the oldest clips.
 * @param {ClipRecord[]} records Sorted newest first.
 * @param {number} limit
 * @returns {Promise<ClipRecord[]>} The clips that remain.
 */
async function trimToLimit(records, limit) {
  if (records.length <= limit) return records;
  const expired = records.slice(limit);
  await chrome.storage.local.remove(expired.flatMap((record) => keysForClip(record.id)));
  return records.slice(0, limit);
}

/**
 * Writes `entries` in one atomic call. If Chrome rejects the write because the
 * storage quota would be exceeded, evicts older clips one at a time and tries
 * again until it fits or nothing is left to evict.
 *
 * @param {Record<string, unknown>} entries
 * @param {ClipRecord[]} evictable Clips that may be sacrificed, newest first.
 */
async function persist(entries, evictable) {
  const candidates = [...evictable];
  for (;;) {
    try {
      await chrome.storage.local.set(entries);
      return;
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      const victim = takeEvictionCandidate(candidates);
      if (!victim) {
        throw new Error('It does not fit in the storage space Chrome gives extensions.', {
          cause: error,
        });
      }
      await chrome.storage.local.remove(keysForClip(victim.id));
    }
  }
}

/**
 * Chooses which clip to give up when storage is full: the oldest image, since
 * images are what fill the quota, and only then the oldest clip of any kind.
 * Dropping strictly by age would discard dozens of tiny text clips before
 * reaching the one image that actually frees space.
 *
 * @param {ClipRecord[]} candidates Newest first. The chosen clip is removed from it.
 */
function takeEvictionCandidate(candidates) {
  let index = candidates.findLastIndex((record) => record.type === 'image');
  if (index === -1) index = candidates.length - 1;
  if (index === -1) return null;
  return candidates.splice(index, 1)[0];
}

/** @param {unknown} error */
function isQuotaError(error) {
  // Chrome reports "… quota exceeded" (the exact wording has changed between versions).
  return /quota/i.test(describeError(error));
}

/** @returns {Promise<string | null>} */
async function readLastHash() {
  const stored = await chrome.storage.local.get(KEYS.STATE);
  const state = stored[KEYS.STATE];
  return state && typeof state.lastHash === 'string' ? state.lastHash : null;
}

/** @param {string[]} keys */
async function removeQuietly(keys) {
  try {
    await chrome.storage.local.remove(keys);
  } catch (error) {
    console.warn('[Klipbod] Could not remove leftover storage entries:', error);
  }
}

/* -------------------------------------------------------------------------- */
/* Notices shown in the popup                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} code
 * @param {string} message
 */
async function setNotice(code, message) {
  try {
    await chrome.storage.local.set({ [KEYS.NOTICE]: { code, message, at: Date.now() } });
  } catch (error) {
    // Most likely storage is completely full; the console is all that is left.
    console.warn('[Klipbod] Could not store a notice for the popup:', error);
  }
}

/** @param {string} code Only a notice with this code is removed. */
async function clearNotice(code) {
  try {
    const stored = await chrome.storage.local.get(KEYS.NOTICE);
    const notice = stored[KEYS.NOTICE];
    if (notice && notice.code === code) await chrome.storage.local.remove(KEYS.NOTICE);
  } catch (error) {
    console.warn('[Klipbod] Could not clear a notice:', error);
  }
}

/** @param {Extract<Observation, {kind: 'skipped'}>} observation */
function describeSkip(observation) {
  switch (observation.reason) {
    case 'text-too-large':
      return (
        `A text copy of ${formatCount(observation.chars)} characters was not saved. ` +
        `Klipbod keeps text up to ${formatCount(LIMITS.MAX_TEXT_CHARS)} characters.`
      );
    case 'image-too-large':
      return Number.isFinite(observation.width) && Number.isFinite(observation.height)
        ? `An image of ${observation.width} × ${observation.height} pixels was not saved because it is too large to store.`
        : 'An image was not saved because it is too large to store.';
    case 'image-unreadable':
      return 'An image on the clipboard could not be decoded, so it was not saved.';
    default:
      return 'A copy could not be saved.';
  }
}

/** @param {unknown} value */
function formatCount(value) {
  return Number.isFinite(value) ? Number(value).toLocaleString('en-US') : 'unknown';
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Checks a clipboard update before anything is written. The reader applies the
 * same limits, so a failure here means a bug rather than normal operation.
 *
 * @param {any} observation
 * @returns {string | null} A description of the problem, or null when valid.
 */
function validateObservation(observation) {
  if (!observation || typeof observation !== 'object') return 'The update is not an object.';

  switch (observation.kind) {
    case 'empty':
      return null;

    case 'skipped':
      if (!isHash(observation.hash)) return 'The skipped clip has no valid identity.';
      if (typeof observation.reason !== 'string') return 'The skipped clip has no reason.';
      return null;

    case 'text':
      if (!isHash(observation.hash)) return 'The text clip has no valid identity.';
      if (typeof observation.text !== 'string' || observation.text.length === 0) {
        return 'The text clip is empty.';
      }
      if (observation.text.length > LIMITS.MAX_TEXT_CHARS) return 'The text clip is too long.';
      return null;

    case 'image':
      if (!isHash(observation.hash)) return 'The image clip has no valid identity.';
      if (observation.storedHash !== undefined && !isHash(observation.storedHash)) {
        return 'The image clip has an invalid secondary identity.';
      }
      if (
        typeof observation.dataUrl !== 'string' ||
        !observation.dataUrl.startsWith(PNG_DATA_URL_PREFIX) ||
        observation.dataUrl.length === PNG_DATA_URL_PREFIX.length
      ) {
        return 'The image clip is not a PNG data URL.';
      }
      if (observation.dataUrl.length > LIMITS.MAX_IMAGE_CHARS) return 'The image clip is too large.';
      if (!isDimension(observation.width) || !isDimension(observation.height)) {
        return 'The image clip has invalid dimensions.';
      }
      if (
        observation.resizedFrom !== undefined &&
        (!observation.resizedFrom ||
          !isDimension(observation.resizedFrom.width) ||
          !isDimension(observation.resizedFrom.height))
      ) {
        return 'The image clip has invalid original dimensions.';
      }
      return null;

    default:
      return 'The update has an unknown kind.';
  }
}

/** @param {unknown} value */
function isHash(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_HASH_LENGTH;
}

/** @param {unknown} value */
function isDimension(value) {
  return Number.isInteger(value) && /** @type {number} */ (value) > 0 && /** @type {number} */ (value) <= MAX_IMAGE_DIMENSION;
}

/**
 * Size in bytes of the PNG encoded in a base64 data URL.
 * @param {string} dataUrl
 */
function decodedLength(dataUrl) {
  const encoded = dataUrl.length - PNG_DATA_URL_PREFIX.length;
  let padding = 0;
  if (dataUrl.endsWith('==')) padding = 2;
  else if (dataUrl.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor((encoded * 3) / 4) - padding);
}
