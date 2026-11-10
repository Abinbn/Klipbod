/**
 * Klipbod — constants and small helpers shared by every extension context:
 *
 *   background.js  service worker; decides what gets stored and enforces limits
 *   offscreen.js   offscreen document; the only context able to read the clipboard
 *   popup.js       toolbar popup; renders the history
 *
 * Storage layout (chrome.storage.local). Every clip is a self-contained set of
 * keys, so adding, re-ordering and deleting are each one atomic call and never
 * rewrite the rest of the history:
 *
 *   clip:<id>       ClipRecord  small metadata object, see the typedef below
 *   text:<id>       string      the text of a text clip
 *   image:<id>      string      PNG data URL of an image clip
 *   klipbod:state   { lastHash }             what was last seen on the clipboard
 *   klipbod:notice  { code, message, at }    latest problem to show in the popup
 */

/**
 * @typedef {Object} ClipRecord
 * @property {string} id
 * @property {'text'|'image'} type
 * @property {number} copiedAt  Epoch milliseconds of the most recent copy.
 * @property {string[]} hashes  Content identities used to recognise repeats.
 * @property {number} [chars]   Text clips: length in UTF-16 code units.
 * @property {number} [width]   Image clips: stored width in pixels.
 * @property {number} [height]  Image clips: stored height in pixels.
 * @property {number} [bytes]   Image clips: size of the stored PNG in bytes.
 * @property {{width: number, height: number}} [resizedFrom]
 *   Image clips: original dimensions, present only when the image had to be
 *   scaled down to fit MAX_IMAGE_CHARS.
 */

/** Limits that keep the history small enough for chrome.storage.local. */
export const LIMITS = Object.freeze({
  /** Maximum number of clips kept. The oldest clip is dropped first. */
  MAX_ITEMS: 50,
  /** Longest text clip that is stored, in UTF-16 code units. Longer text is skipped. */
  MAX_TEXT_CHARS: 500_000,
  /** Largest stored image, as the length of its data URL. Larger images are scaled down. */
  MAX_IMAGE_CHARS: 3 * 1024 * 1024,
});

export const KEYS = Object.freeze({
  CLIP_PREFIX: 'clip:',
  TEXT_PREFIX: 'text:',
  IMAGE_PREFIX: 'image:',
  STATE: 'klipbod:state',
  NOTICE: 'klipbod:notice',
});

/**
 * chrome.runtime.sendMessage delivers to every extension context at once, so
 * each message names the context it is meant for and the others ignore it.
 */
export const TARGET = Object.freeze({
  WORKER: 'worker',
  READER: 'reader',
});

export const MESSAGE = Object.freeze({
  /** reader → worker: the clipboard now holds something different. */
  CLIPBOARD_CHANGED: 'klipbod:clipboard-changed',
  /** reader → worker: reading the clipboard started failing, or recovered. */
  READER_STATUS: 'klipbod:reader-status',
  /** worker → reader: read the clipboard now instead of waiting for the timer. */
  POLL_NOW: 'klipbod:poll-now',
  /** popup → worker: make sure monitoring is running and the history is current. */
  SYNC: 'klipbod:sync',
});

export const NOTICE = Object.freeze({
  CLIPBOARD_UNREADABLE: 'clipboard-unreadable',
  CLIP_SKIPPED: 'clip-skipped',
  STORAGE_FAILED: 'storage-failed',
});

export const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';

/** @param {string} id */
export const clipKey = (id) => KEYS.CLIP_PREFIX + id;

/**
 * Storage key holding a clip's content.
 * @param {Pick<ClipRecord, 'id' | 'type'>} record
 */
export const payloadKey = (record) =>
  (record.type === 'image' ? KEYS.IMAGE_PREFIX : KEYS.TEXT_PREFIX) + record.id;

/**
 * Every key that can belong to a clip. Removing a key that does not exist is a
 * no-op, so callers can delete a clip without knowing its type.
 * @param {string} id
 */
export const keysForClip = (id) => [
  KEYS.CLIP_PREFIX + id,
  KEYS.TEXT_PREFIX + id,
  KEYS.IMAGE_PREFIX + id,
];

/** @param {string} key */
export const isHistoryKey = (key) =>
  key.startsWith(KEYS.CLIP_PREFIX) ||
  key.startsWith(KEYS.TEXT_PREFIX) ||
  key.startsWith(KEYS.IMAGE_PREFIX);

/**
 * Structural check for values read back from storage.
 * @param {unknown} value
 * @returns {value is ClipRecord}
 */
export function isClipRecord(value) {
  if (!value || typeof value !== 'object') return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (typeof record.id !== 'string' || record.id.length === 0) return false;
  if (!Number.isFinite(record.copiedAt)) return false;
  if (!Array.isArray(record.hashes) || !record.hashes.every((hash) => typeof hash === 'string')) {
    return false;
  }
  if (record.type === 'text') return Number.isFinite(record.chars);
  if (record.type === 'image') {
    return (
      Number.isFinite(record.width) &&
      Number.isFinite(record.height) &&
      /** @type {number} */ (record.width) > 0 &&
      /** @type {number} */ (record.height) > 0
    );
  }
  return false;
}

/**
 * Sort order of the history: most recently copied first.
 * @param {ClipRecord} a
 * @param {ClipRecord} b
 */
export function compareNewestFirst(a, b) {
  if (a.copiedAt !== b.copiedAt) return b.copiedAt - a.copiedAt;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** @param {unknown} error */
export function describeError(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Unknown error';
}

/**
 * Lists the keys in chrome.storage.local without loading their values where
 * the browser supports it (StorageArea.getKeys, Chrome 130+).
 * Not available in the offscreen document, which has no chrome.storage.
 * @returns {Promise<string[]>}
 */
export async function listStorageKeys() {
  const area = chrome.storage.local;
  if (typeof area.getKeys === 'function') return area.getKeys();
  return Object.keys(await area.get(null));
}

/**
 * Reads the metadata of every clip without loading clip contents.
 *
 * A clip is only reported when its record is well formed and its content key
 * exists. Anything else that looks like history is returned as `garbage` so
 * the service worker can remove it; that covers leftovers from an interrupted
 * write as well as data damaged by hand.
 *
 * @returns {Promise<{records: ClipRecord[], garbage: string[]}>}
 *   `records` is sorted newest first.
 */
export async function readHistoryIndex() {
  const keys = await listStorageKeys();
  const present = new Set(keys);
  const clipKeys = keys.filter((key) => key.startsWith(KEYS.CLIP_PREFIX));
  const stored = clipKeys.length > 0 ? await chrome.storage.local.get(clipKeys) : {};

  /** @type {ClipRecord[]} */
  const records = [];
  /** @type {string[]} */
  const garbage = [];
  const claimed = new Set();

  for (const key of clipKeys) {
    const record = stored[key];
    if (isClipRecord(record) && clipKey(record.id) === key && present.has(payloadKey(record))) {
      records.push(record);
      claimed.add(payloadKey(record));
    } else {
      garbage.push(key);
    }
  }

  for (const key of keys) {
    const isPayload = key.startsWith(KEYS.TEXT_PREFIX) || key.startsWith(KEYS.IMAGE_PREFIX);
    if (isPayload && !claimed.has(key)) garbage.push(key);
  }

  records.sort(compareNewestFirst);
  return { records, garbage };
}
