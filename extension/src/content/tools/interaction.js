/**
 * Ported from browser-automation/extension/tools/interaction-tools.js
 */

export async function clickElement(opaqueId, graph) {
    const el = window.CYCLOPS.nodeFor(opaqueId);
    if (!el) {
        return { ok: false, error: `unknown target ${opaqueId}` };
    }
    if (!el.isConnected) {
        return { ok: false, error: `target ${opaqueId} left the DOM` };
    }

    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    
    // Add brief pause for scroll to finish
    await new Promise(r => setTimeout(r, 200));

    // Flash for visual debugging
    if (window.CYCLOPS.flash) {
        window.CYCLOPS.flash(el);
    }

    let results = [];
    
    // 1. Focus
    try {
        if (typeof el.focus === 'function') {
            el.focus();
            results.push('focus');
        }
    } catch (e) {
        console.warn('focus failed', e);
    }

    // 2. Native DOM click
    try {
        el.click();
        results.push('standard_click');
    } catch (e) {
        console.warn('standard click failed', e);
    }

    // 3. Pointer & MouseEvent chain
    try {
        const opts = { bubbles: true, cancelable: true, view: window };
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        results.push('mouse_sequence');
    } catch (e) {
        console.warn('mouse sequence failed', e);
    }

    // 4. Center Coordinate MouseEvent
    try {
        const rect = el.getBoundingClientRect();
        const clickEvent = new MouseEvent('click', {
            view: window,
            bubbles: true,
            cancelable: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2
        });
        el.dispatchEvent(clickEvent);
        results.push('coordinate_click');
    } catch (e) {
        console.warn('coordinate click failed', e);
    }

    if (results.length > 0) {
        return { ok: true, note: `clicked via ${results.join(', ')}` };
    } else {
        return { ok: false, error: 'All click methods failed' };
    }
}

export async function clickCoordinate(x, y, doubleClick = false) {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    const actualX = Math.round(x * viewportWidth);
    const actualY = Math.round(y * viewportHeight);
    
    let element = document.elementFromPoint(actualX, actualY);
    
    if (!element) {
        return { ok: false, error: `No element found at coordinates (${actualX}, ${actualY})` };
    }
    
    const clickOptions = {
        bubbles: true,
        cancelable: true,
        clientX: actualX,
        clientY: actualY,
        button: 0
    };
    
    element.dispatchEvent(new MouseEvent('mousedown', clickOptions));
    element.dispatchEvent(new MouseEvent('mouseup', clickOptions));
    element.dispatchEvent(new MouseEvent('click', clickOptions));
    element.click();
    
    if (doubleClick) {
        await new Promise(r => setTimeout(r, 50));
        element.dispatchEvent(new MouseEvent('dblclick', clickOptions));
        element.click();
    }
    
    return { ok: true, note: `clicked coordinate ${x},${y} on ${element.tagName}` };
}
