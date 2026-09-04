/**
 * Cyclops content script — message bus.
 *
 * Loaded last, after extractor.js / executor.js / overlay.js have populated
 * window.CYCLOPS. This file does routing and nothing else.
 *
 * Content scripts are classic scripts, not ES modules, so message type strings
 * are duplicated from lib/config.js. Keep them in sync.
 */

(() => {
  if (window.__CYCLOPS_BUS__) return;   // guard against double injection
  window.__CYCLOPS_BUS__ = true;

  const C = window.CYCLOPS;

  // If the other content modules didn't load, say so loudly rather than
  // failing with an undefined-is-not-a-function deep in a handler. Checked per
  // message, not once at load: a re-injection can fill the gaps later.
  const missing = () => ['extract', 'execute', 'overlay'].filter((k) => !window.CYCLOPS?.[k]);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const gaps = missing();
    if (gaps.length) {
      sendResponse({ ok: false, error: `content modules missing: ${gaps.join(', ')} — reload the tab` });
      return false;
    }

    switch (msg.type) {
      case 'PING':
        // Keep in sync with CONTENT_VERSION in background/sw.js.
        sendResponse({ ok: true, version: 2 });
        return false;

      case 'EXTRACT': {
        try {
          sendResponse({ ok: true, graph: C.extract() });
        } catch (err) {
          sendResponse({ ok: false, error: String(err.message || err) });
        }
        return false;
      }

      // Scan + draw the overlay, used by the popup's Inspect button.
      case 'INSPECT': {
        try {
          const graph = C.extract();
          if (msg.show === false) C.overlay.hide();
          else C.overlay.show(graph);
          sendResponse({ ok: true, graph });
        } catch (err) {
          sendResponse({ ok: false, error: String(err.message || err) });
        }
        return false;
      }

      case 'OVERLAY_OFF':
        C.overlay.hide();
        sendResponse({ ok: true });
        return false;

      case 'EXECUTE':
        // Boxes drawn over the page would be stale the moment we act.
        C.overlay.hide();
        C.execute(msg.action).then(sendResponse);
        return true;   // async response

      default:
        sendResponse({ ok: false, error: `content script does not handle "${msg.type}"` });
        return false;
    }
  });
})();
