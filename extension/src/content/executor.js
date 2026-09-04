/**
 * Cyclops — action executor.
 *
 * Takes an action from the server and performs it on the real page. The server
 * only ever names an opaque id ("e12"); resolving that to a live node happens
 * here and nowhere else, so a stale or hostile plan fails safely instead of
 * clicking something arbitrary.
 */

window.CYCLOPS = window.CYCLOPS || {};

(() => {
  const C = window.CYCLOPS;

  /**
   * React and Vue keep their own copy of an input's value. Assigning `.value`
   * directly bypasses their setter and the framework never sees the change —
   * the field looks filled and then silently reverts. Going through the native
   * prototype descriptor is what makes a fill actually stick.
   */
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
  }

  function flash(el, colour = '#22d3ee') {
    const prev = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = `3px solid ${colour}`;
    el.style.outlineOffset = '2px';
    setTimeout(() => {
      el.style.outline = prev;
      el.style.outlineOffset = prevOffset;
    }, 700);
  }

  function fireMouse(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  function fillField(el, value) {
    el.focus();
    setNativeValue(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }

  /** Match by exact value, then by visible text, then case-insensitively. */
  function chooseOption(select, wanted) {
    const opts = [...select.options];
    const want = String(wanted).trim().toLowerCase();
    const hit =
      opts.find((o) => o.value === wanted) ||
      opts.find((o) => o.text.trim() === wanted) ||
      opts.find((o) => o.value.toLowerCase() === want) ||
      opts.find((o) => o.text.trim().toLowerCase() === want) ||
      opts.find((o) => o.text.trim().toLowerCase().includes(want));
    if (!hit) return null;
    select.value = hit.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return hit.text.trim();
  }

  function doScroll(action) {
    const amount = action.amount_px ?? Math.round(window.innerHeight * 0.8);
    const map = {
      down: () => window.scrollBy({ top: amount, behavior: 'instant' }),
      up: () => window.scrollBy({ top: -amount, behavior: 'instant' }),
      top: () => window.scrollTo({ top: 0, behavior: 'instant' }),
      bottom: () => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }),
    };
    (map[action.direction] || map.down)();
  }

  async function execute(action) {
    if (action.action === 'done') {
      return { ok: true, note: action.summary || 'done' };
    }
    if (action.action === 'ask_user') {
      return { ok: true, note: `asked: ${action.question}`, halt: true };
    }
    if (action.action === 'scroll') {
      doScroll(action);
      return { ok: true, note: `scrolled ${action.direction}` };
    }

    const el = C.nodeFor(action.target);
    if (!el) return { ok: false, error: `unknown target ${action.target}` };
    if (!el.isConnected) return { ok: false, error: `target ${action.target} left the DOM` };

    el.scrollIntoView({ block: 'center', behavior: 'instant' });

    switch (action.action) {
      case 'click':
        flash(el);
        fireMouse(el);
        return { ok: true, note: `clicked "${labelOf(el)}"` };

      case 'fill': {
        if (!('value' in el)) return { ok: false, error: `${action.target} is not a field` };
        flash(el);
        fillField(el, action.value);
        return { ok: true, note: `filled "${labelOf(el)}"` };
      }

      case 'select': {
        if (el.tagName.toLowerCase() !== 'select') {
          return { ok: false, error: `${action.target} is not a dropdown` };
        }
        flash(el);
        const chosen = chooseOption(el, action.option);
        return chosen
          ? { ok: true, note: `selected "${chosen}"` }
          : { ok: false, error: `no option matching "${action.option}"` };
      }

      default:
        return { ok: false, error: `unsupported action "${action.action}"` };
    }
  }

  function labelOf(el) {
    return (el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      (el.innerText || '').trim() ||
      el.name || el.id || el.tagName.toLowerCase()).slice(0, 60);
  }

  C.execute = execute;
})();
