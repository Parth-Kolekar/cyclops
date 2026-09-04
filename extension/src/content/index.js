/**
 * Cyclops content script — Phase 0
 *
 * Two jobs, both deliberately dumb for now:
 *   1. EXTRACT  — walk the page, hand back a flat list of interactive elements
 *                 with opaque ids ("e0", "e1", ...). Phase 1 replaces this with
 *                 the real Screen Graph (a11y names, normalised bboxes, etc).
 *   2. EXECUTE  — take an action from the server and perform it on the page.
 *
 * Content scripts are NOT ES modules, so no imports here. Message type strings
 * are duplicated from lib/config.js on purpose; keep them in sync.
 */

(() => {
  if (window.__CYCLOPS_CONTENT__) return; // guard against double injection
  window.__CYCLOPS_CONTENT__ = true;

  /** id -> live DOM node. Never serialised, never leaves this page. */
  const NODE_MAP = new Map();

  const INTERACTIVE_SELECTOR = 'a[href], button, input, select, textarea, [role="button"], [onclick]';

  // ---------------------------------------------------------------- extract

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width * rect.height < 60) return false;
    // must intersect the viewport
    if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
    if (rect.right < 0 || rect.left > window.innerWidth) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    if (parseFloat(cs.opacity) < 0.05) return false;
    return true;
  }

  /** Rough accessible-name resolution. Phase 1 makes this proper. */
  function labelFor(el) {
    const byAria = el.getAttribute('aria-label');
    if (byAria) return byAria.trim();

    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl && lbl.innerText.trim()) return lbl.innerText.trim();
    }
    const wrapping = el.closest('label');
    if (wrapping && wrapping.innerText.trim()) return wrapping.innerText.trim();

    const ph = el.getAttribute('placeholder');
    if (ph) return ph.trim();

    const text = (el.innerText || '').trim();
    if (text) return text.slice(0, 120);

    return el.getAttribute('title') || el.getAttribute('name') || el.tagName.toLowerCase();
  }

  function roleFor(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;

    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      return 'textbox';
    }
    return 'generic';
  }

  function extract() {
    NODE_MAP.clear();
    const elements = [];
    let i = 0;

    for (const el of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
      if (!isVisible(el)) continue;

      const id = `e${i++}`;
      NODE_MAP.set(id, el);

      const r = el.getBoundingClientRect();
      elements.push({
        id,
        role: roleFor(el),
        label: labelFor(el),
        value: 'value' in el ? String(el.value ?? '') : undefined,
        bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        enabled: !el.disabled,
        input_type: el.tagName.toLowerCase() === 'input' ? (el.type || 'text') : undefined,
        source: 'dom',
      });

      if (elements.length >= 120) break; // latency guard, see design doc §5.2
    }

    return {
      schema: 'cyclops.sg.v0',
      captured_at: Date.now(),
      page: {
        url_host: location.host,
        title: document.title,
        kind: 'unknown',
      },
      viewport: {
        w: window.innerWidth,
        h: window.innerHeight,
        scroll_x: Math.round(window.scrollX),
        scroll_y: Math.round(window.scrollY),
        dpr: window.devicePixelRatio,
      },
      elements,
    };
  }

  // ---------------------------------------------------------------- execute

  /**
   * React/Vue keep their own copy of an input's value. Assigning `.value`
   * directly bypasses their setter and the framework never sees the change.
   * Going through the native prototype descriptor is what makes fills stick.
   */
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function flash(el) {
    const prev = el.style.outline;
    el.style.outline = '3px solid #22d3ee';
    setTimeout(() => { el.style.outline = prev; }, 600);
  }

  async function execute(action) {
    if (action.action === 'done') {
      return { ok: true, note: action.summary || 'done' };
    }

    const el = NODE_MAP.get(action.target);
    if (!el) return { ok: false, error: `unknown target ${action.target}` };
    if (!el.isConnected) return { ok: false, error: `target ${action.target} left the DOM` };

    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    flash(el);

    switch (action.action) {
      case 'click': {
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        el.click();
        return { ok: true, note: `clicked ${labelFor(el)}` };
      }
      case 'fill': {
        el.focus();
        setNativeValue(el, action.value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
        return { ok: true, note: `filled ${labelFor(el)}` };
      }
      case 'select': {
        setNativeValue(el, action.option);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, note: `selected ${action.option}` };
      }
      default:
        return { ok: false, error: `unsupported action ${action.action}` };
    }
  }

  // ---------------------------------------------------------------- bus

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'EXTRACT') {
      sendResponse({ ok: true, graph: extract() });
      return false;
    }
    if (msg.type === 'EXECUTE') {
      execute(msg.action).then(sendResponse);
      return true; // async response
    }
    return false;
  });
})();
