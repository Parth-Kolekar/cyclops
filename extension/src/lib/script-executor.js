/**
 * Cyclops — resilient script executor.
 *
 * Wraps chrome.scripting.executeScript with:
 *   1. A 15-second Promise timeout to prevent hanging the service worker.
 *   2. JSON argument sanitisation to avoid DataCloneError.
 *   3. Tab accessibility checks (rejects chrome://, edge://, about:// pages).
 *
 * Ported from browser-automation/extension/utils/script-executor.js and
 * adapted for ES module usage in the Cyclops MV3 service worker.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * URLs that chrome.scripting.executeScript cannot inject into.
 * Attempting to inject into these produces a cryptic error; we fail early
 * with a descriptive message instead.
 */
const BLOCKED_URL_RE = /^(chrome|chrome-extension|edge|about):/;

/**
 * Make an argument safe for the structured-clone transfer that
 * chrome.scripting.executeScript uses internally.  Functions, undefined,
 * and anything that fails JSON.stringify are replaced with null.
 */
function sanitiseArg(arg) {
  if (arg === undefined || arg === null) return null;
  if (typeof arg === 'function') return null;
  try {
    JSON.stringify(arg);
    return arg;
  } catch {
    console.warn('[ScriptExecutor] argument dropped (not serialisable):', typeof arg);
    return null;
  }
}

export class ScriptExecutor {
  /**
   * Inject `func` into the given tab and return its result.
   *
   * @param {number}   tabId       Chrome tab ID to inject into.
   * @param {Function} func        A plain function reference (not a string).
   * @param {any[]}    args        Arguments forwarded to `func`.  Each one is
   *                               sanitised before transfer.
   * @param {number}   timeoutMs   Maximum wall-clock time before the Promise
   *                               rejects.  Defaults to 15 000 ms.
   * @returns {Promise<any>}       The return value of `func` from the tab.
   */
  static execute(tabId, func, args = [], timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      // --- timeout race ---
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Script execution timed out after ${timeoutMs} ms — ` +
            'the page may be unresponsive or the injected function is hanging',
          ),
        );
      }, timeoutMs);

      // --- tab accessibility check ---
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) {
          clearTimeout(timer);
          reject(new Error(`Cannot access tab ${tabId}: ${chrome.runtime.lastError.message}`));
          return;
        }

        if (BLOCKED_URL_RE.test(tab.url || '')) {
          clearTimeout(timer);
          reject(new Error(`Cannot inject into internal page: ${tab.url}`));
          return;
        }

        // --- sanitise args ---
        const safeArgs = args.map(sanitiseArg);

        // --- inject ---
        chrome.scripting.executeScript(
          {
            target: { tabId },
            func,
            args: safeArgs,
          },
          (results) => {
            clearTimeout(timer);

            if (chrome.runtime.lastError) {
              reject(
                new Error(`Script injection failed: ${chrome.runtime.lastError.message}`),
              );
              return;
            }

            if (results && results.length > 0) {
              resolve(results[0].result);
            } else {
              resolve(null);
            }
          },
        );
      });
    });
  }

  /**
   * Quick predicate: can we inject scripts into this tab at all?
   *
   * @param {number} tabId
   * @returns {Promise<boolean>}
   */
  static async isTabAccessible(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      return !BLOCKED_URL_RE.test(tab.url || '');
    } catch {
      return false;
    }
  }
}
