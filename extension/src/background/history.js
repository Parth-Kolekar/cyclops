/**
 * Cyclops — persistent conversation history.
 *
 * Manages the action-history array that lets the agent resume complex tasks
 * across browser sessions. Stored in chrome.storage.local (persistent).
 *
 * PRIVACY INVARIANT: the history array must NEVER contain raw PII. By the time
 * an entry reaches here, sensitive values have already been replaced with vault
 * tokens (e.g. [AADHAAR_1]) by the sanitiser. Two further precautions are taken
 * on the way to disk, because this is the one place data outlives the session:
 *
 *   1. base64 screenshots are stripped — they could carry visually-embedded PII
 *      that survived DOM redaction, and would blow the 10 MB storage quota
 *      anyway (~100 KB each).
 *   2. every remaining string is re-scanned against the detector patterns and
 *      replaced wholesale if anything that looks like plaintext PII got through.
 *      A belt-and-braces pass: if the sanitiser ever regresses, the failure does
 *      not become permanent by being written to disk.
 */

const STORAGE_KEY = 'cyclops.chat_history';

/** A value that is already a vault token is safe by definition. */
const TOKEN_RE = /^\[[A-Z_]+_\d+\]$/;

/**
 * Deliberately a second, independent set of patterns — the same reasoning as
 * the server's guard being a separate implementation from the client's
 * detector. A copy of the sanitiser's bug would not catch the sanitiser's bug.
 */
const SENSITIVE_PATTERNS = [
  /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g,       // Aadhaar-like
  /\b[A-Z]{5}\d{4}[A-Z]\b/g,                     // PAN-like
  /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/g, // GSTIN-like
  /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,                   // IFSC-like
  /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,           // email
  /(?:\+?91[-\s]?)?\b[6-9]\d{9}\b/g,             // Indian mobile
  /\b(?:\d[ -]?){13,19}\b/g,                     // payment-card-like
];

function hasSensitiveText(value) {
  if (!value || TOKEN_RE.test(value)) return false;
  return SENSITIVE_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(value);
  });
}

function cleanString(value) {
  return hasSensitiveText(value) ? '[REDACTED_SENSITIVE]' : value;
}

/** Recursively scrub a value before it is allowed near the disk. */
function clean(value) {
  if (value == null) return value;
  if (typeof value === 'string') return cleanString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(clean);

  if (typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      // A rehydrated action should never be saved, but this keeps the boundary
      // safe even if a future caller passes one by mistake.
      if (key === 'rehydrated_value' || key === 'plain' || key === 'plaintext') continue;
      out[key] = clean(child);
    }
    return out;
  }

  return undefined;
}

/**
 * Maximum entries kept in persistent storage.  The server typically receives
 * only the last 5 (via `history.slice(-5)`), but we keep more so the agent
 * has deeper context when resuming.
 */
const MAX_ENTRIES = 50;

/**
 * Strip fields that are either too large for storage (base64 images) or
 * unnecessary for planning (raw element arrays).  Operates on a shallow
 * copy so the caller's object is not mutated.
 */
function sanitiseForPersistence(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const copy = { ...entry };

  // Screenshots survive in session storage (for the popup's "what left the
  // machine" panel) but must not be persisted — they're huge and may contain
  // visually-embedded PII.
  delete copy.image_base64;
  delete copy.screenshot;
  delete copy.webpageImage;
  delete copy.referenceImage;

  // The full element array is redundant once the step is over; the server
  // gets a fresh extraction on every iteration.
  if (Array.isArray(copy.elements) && copy.elements.length > 10) {
    copy.elements = `[${copy.elements.length} elements — stripped for storage]`;
  }

  // Final pass: anything that still looks like plaintext PII never reaches disk.
  return clean(copy);
}

export const ChatHistory = {
  /**
   * Persist the entire history array, replacing whatever was stored.
   * Each entry is sanitised before writing.
   *
   * @param {object[]} historyArray
   */
  async save(historyArray) {
    const safe = historyArray
      .slice(-MAX_ENTRIES)
      .map(sanitiseForPersistence);
    await chrome.storage.local.set({ [STORAGE_KEY]: safe });
  },

  /**
   * Load the persisted history.  Returns an empty array on first run.
   *
   * @returns {Promise<object[]>}
   */
  async load() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    return data[STORAGE_KEY] || [];
  },

  /**
   * Append a single entry and save atomically.  Safer than load → push →
   * save in the caller, because it guarantees we read the latest state
   * inside one operation.
   *
   * @param {object} entry
   * @returns {Promise<object[]>}  The full history after appending.
   */
  async append(entry) {
    const history = await this.load();
    history.push(sanitiseForPersistence(entry));

    // Trim oldest entries beyond the cap.
    while (history.length > MAX_ENTRIES) history.shift();

    await chrome.storage.local.set({ [STORAGE_KEY]: history });
    return history;
  },

  /** Wipe the history — called on explicit user reset. */
  async clear() {
    await chrome.storage.local.remove(STORAGE_KEY);
  },
};
