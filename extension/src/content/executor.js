/**
 * Cyclops — action executor.
 *
 * Routes execution commands from the server to the robust tool scripts.
 */

window.CYCLOPS = window.CYCLOPS || {};

(() => {
  const C = window.CYCLOPS;

  // Cache for dynamically imported tool modules
  const tools = {};

  async function loadTool(name) {
    if (!tools[name]) {
      const url = chrome.runtime.getURL(`src/content/tools/${name}.js`);
      tools[name] = await import(url);
    }
    return tools[name];
  }

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
    if (action.action === 'ask_user' || action.action === 'chat_response') {
      return { ok: true, note: `asked: ${action.question || action.message}`, halt: true };
    }
    if (action.action === 'wait') {
      const util = await loadTool('utility');
      return await util.wait(action.seconds);
    }
    if (action.action === 'extract_text') {
      const util = await loadTool('utility');
      return await util.extractPageText();
    }
    if (action.action === 'execute_js') {
      const util = await loadTool('utility');
      return await util.executeJs(action.code);
    }
    
    // 2. Navigation Tools
    if (['navigate', 'goback', 'reload', 'scroll'].includes(action.action)) {
      const nav = await loadTool('navigation');
      switch (action.action) {
        case 'navigate': return await nav.navigate(action.url);
        case 'goback': return await nav.goBack();
        case 'reload': return await nav.reloadPage();
        case 'scroll': return await nav.scrollPage(action.direction, action.amount_px);
      }
    }

    // 3. Coordinate Interactions
    if (action.action === 'click_coordinate') {
      const int = await loadTool('interaction');
      return await int.clickCoordinate(action.x, action.y, action.double_click);
    }

    // 4. Element Interactions (Requires resolving opaque ID)
    const el = action.target ? C.nodeFor(action.target) : null;
    if (action.target && !el) return { ok: false, error: `unknown target ${action.target}` };
    
    // Some tools might allow null target (e.g. press_key defaults to activeElement)
    if (action.action === 'press_key') {
      const txt = await loadTool('text');
      return await txt.pressKey(action.key, action.target);
    }

    // Tools below strictly require a resolved target element
    if (!el) return { ok: false, error: `missing or unknown target` };
    if (!el.isConnected) return { ok: false, error: `target ${action.target} left the DOM` };

    switch (action.action) {
      case 'click': {
        const int = await loadTool('interaction');
        return await int.clickElement(action.target);
      }
      case 'double_click': {
        const int = await loadTool('interaction');
        await int.clickElement(action.target);
        await new Promise(r => setTimeout(r, 100));
        return await int.clickElement(action.target);
      }
      case 'fill': {
        const txt = await loadTool('text');
        return await txt.typeText(action.target, action.value);
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

  C.execute = execute;
})();
