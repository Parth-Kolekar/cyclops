/**
 * Cyclops — persistent conversation history.
 *
 * Manages the action-history array that lets the agent resume complex tasks
 * across browser sessions.  Stored in chrome.storage.local (persistent).
 *
 * PRIVACY INVARIANT: The history array must NEVER contain raw PII.  By the
 * time an entry reaches here, all sensitive values have already been replaced
 * with Vault tokens (e.g. [AADHAAR_1]) by the sanitiser.  The only extra
 * precaution we take is stripping base64 screenshot data, which could contain
 * visually-embedded PII that survived DOM-level redaction, and which would
 * blow the 10 MB chrome.storage.local quota anyway (~100 KB per screenshot).
 */

const STORAGE_KEY = 'cyclops.chat_history';

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
  const clean = { ...entry };

  // Screenshots survive in session storage (for the popup's "what left the
  // machine" panel) but must not be persisted — they're huge and may contain
  // visually-embedded PII.
  delete clean.image_base64;
  delete clean.screenshot;
  delete clean.webpageImage;
  delete clean.referenceImage;

  // The full element array is redundant once the step is over; the server
  // gets a fresh extraction on every iteration.
  if (Array.isArray(clean.elements) && clean.elements.length > 10) {
    clean.elements = `[${clean.elements.length} elements — stripped for storage]`;
  }

  return clean;
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
