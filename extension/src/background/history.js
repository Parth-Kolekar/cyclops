/**
 * Cyclops persistent conversation history.
 *
 * This log is allowed to survive browser restarts because it stores only the
 * safe side of the conversation: tool names, opaque element ids, vault tokens,
 * and execution notes that never echo filled values. Anything that resembles
 * plaintext PII is redacted before it touches chrome.storage.local.
 */

const HISTORY_KEY = 'cyclops.chat_history';
const MAX_HISTORY = 80;

const TOKEN_RE = /^\[[A-Z_]+_\d+\]$/;

const SENSITIVE_PATTERNS = [
  /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g,          // Aadhaar-like
  /\b[A-Z]{5}\d{4}[A-Z]\b/g,                         // PAN-like
  /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/g,    // GSTIN-like
  /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,                       // IFSC-like
  /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,               // email
  /(?:\+?91[-\s]?)?\b[6-9]\d{9}\b/g,                // Indian mobile
  /\b(?:\d[ -]?){13,19}\b/g,                         // payment-card-like
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

async function write(history) {
  await chrome.storage.local.set({ [HISTORY_KEY]: history.slice(-MAX_HISTORY) });
}

export const ChatHistory = {
  sanitise(historyArray) {
    if (!Array.isArray(historyArray)) return [];
    return historyArray.map(clean).slice(-MAX_HISTORY);
  },

  async save(historyArray) {
    await write(this.sanitise(historyArray));
  },

  async append(entry) {
    const history = await this.load();
    history.push(clean(entry));
    await write(history);
    return history.slice(-MAX_HISTORY);
  },

  async load() {
    const data = await chrome.storage.local.get(HISTORY_KEY);
    return this.sanitise(data[HISTORY_KEY] || []);
  },

  async clear() {
    await chrome.storage.local.remove(HISTORY_KEY);
  },
};

