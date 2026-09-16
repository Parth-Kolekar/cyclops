/**
 * Cyclops — action executor.
 *
 * Routes execution commands from the server to the robust tool scripts.
 *
 * The tools are imported statically and bundled into one classic script at
 * build time. They used to be fetched at run time with
 * `import(chrome.runtime.getURL(...))`, which works on a page that sends no
 * CSP — our own demo pages, served by python's http.server — and is refused on
 * most real sites, because a dynamic import from a content script is checked
 * against the HOST PAGE's script-src. That is why the agent appeared to work
 * only on the demo portal. Nothing is fetched at run time now, so no page's
 * policy has an opinion about it.
 */

import * as interaction from './tools/interaction.js';
import * as navigation from './tools/navigation.js';
import * as text from './tools/text.js';
import * as utility from './tools/utility.js';

window.CYCLOPS = window.CYCLOPS || {};

(() => {
  const C = window.CYCLOPS;

  function flash(el, colour = '#22d3ee') {
    const prev = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = `3px solid ${colour}`;
    el.style.outlineOffset = '2px';
    setTimeout(() => {
      if (el) {
        el.style.outline = prev;
        el.style.outlineOffset = prevOffset;
      }
    }, 700);
  }
  
  // Expose flash for tools to use
  C.flash = flash;

  /** Legacy select logic - kept native for simplicity as it relies on visible text */
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

  function labelOf(el) {
    return (el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      (el.innerText || '').trim() ||
      el.name || el.id || el.tagName.toLowerCase()).slice(0, 60);
  }

  async function execute(action) {
    // 1. Non-DOM Tools
    if (action.action === 'done' || action.action === 'exit') {
      return { ok: true, note: action.summary || 'done' };
    }
    // ask_user blocks until a human answers. chat_response is one-way — the
    // agent says something and carries straight on, which is the whole
    // distinction the prompt teaches.
    if (action.action === 'ask_user') {
      return { ok: true, note: `asked: ${action.question}`, halt: true };
    }
    if (action.action === 'chat_response') {
      return { ok: true, note: action.message };
    }
    if (action.action === 'wait') {
      return await utility.wait(action.seconds);
    }
    if (action.action === 'extract_text') {
      return await utility.extractPageText();
    }
    if (action.action === 'execute_js') {
      return await utility.executeJs(action.code);
    }
    
    // 2. Navigation Tools
    if (['navigate', 'goback', 'reload', 'scroll'].includes(action.action)) {
      switch (action.action) {
        case 'navigate': return await navigation.navigate(action.url || (action.host ? `${action.host}${action.path || '/'}` : ''));
        case 'goback': return await navigation.goBack();
        case 'reload': return await navigation.reloadPage();
        case 'scroll': return await navigation.scrollPage(action.direction, action.amount_px);
      }
    }

    // 3. Coordinate Interactions
    if (action.action === 'click_coordinate') {
      return await interaction.clickCoordinate(action.x, action.y, action.double_click);
    }

    // 4. Element Interactions (Requires resolving opaque ID)
    const el = action.target ? C.nodeFor(action.target) : null;
    if (action.target && !el) return { ok: false, error: `unknown target ${action.target}` };
    
    // Some tools might allow null target (e.g. press_key defaults to activeElement)
    if (action.action === 'press_key') {
      return await text.pressKey(action.key, action.target);
    }

    // Tools below strictly require a resolved target element
    if (!el) return { ok: false, error: `missing or unknown target` };
    if (!el.isConnected) return { ok: false, error: `target ${action.target} left the DOM` };

    switch (action.action) {
      case 'click':
        return await interaction.clickElement(action.target);
      case 'double_click': {
        await interaction.clickElement(action.target);
        await new Promise((r) => setTimeout(r, 100));
        return await interaction.clickElement(action.target);
      }
      case 'fill':
        return await text.typeText(action.target, action.value);
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

  C.execute = execute;
})();
