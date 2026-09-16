export async function typeText(opaqueId, text, graph) {
    const el = window.CYCLOPS.nodeFor(opaqueId);
    if (!el) {
        return { ok: false, error: `unknown target ${opaqueId}` };
    }
    if (!el.isConnected) {
        return { ok: false, error: `target ${opaqueId} left the DOM` };
    }

    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await new Promise(r => setTimeout(r, 100));

    if (window.CYCLOPS.flash) {
        window.CYCLOPS.flash(el);
    }

    // 1. Focus with retry
    let focusAttempts = 0;
    let focused = false;
    while (!focused && focusAttempts < 3) {
        focusAttempts++;
        try {
            if (focusAttempts === 1) {
                el.click();
                el.focus();
            } else if (focusAttempts === 2) {
                el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                el.focus();
                el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            } else {
                el.focus();
                if (typeof el.select === 'function') el.select();
            }
            if (document.activeElement === el) focused = true;
        } catch (e) {
            console.warn('focus attempt failed', e);
        }
        if (!focused) await new Promise(r => setTimeout(r, 50));
    }

    const tagName = el.tagName.toLowerCase();
    const isStandardInput = tagName === 'input' || tagName === 'textarea';
    const isContentEditable = el.contentEditable === 'true' || el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox';

    // 2. Clear content
    if (isStandardInput) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (isContentEditable) {
        try {
            el.focus();
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(el);
            selection.removeAllRanges();
            selection.addRange(range);
            if (document.execCommand) document.execCommand('delete');
        } catch (e) {
            el.innerHTML = '';
            el.textContent = '';
        }
    }

    // 3. Inject text
    if (isStandardInput) {
        try {
            el.value = text;
            if (text.length > 0) {
                el.dispatchEvent(new Event('focus', { bubbles: true }));
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
                if (tagName === 'input' && nativeInputValueSetter) {
                    nativeInputValueSetter.call(el, text);
                } else if (tagName === 'textarea' && nativeTextAreaValueSetter) {
                    nativeTextAreaValueSetter.call(el, text);
                }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } catch (e) {
            console.error('Standard input failed', e);
        }
    } else if (isContentEditable) {
        let success = false;
        
        if (navigator.clipboard && window.ClipboardEvent) {
            try {
                el.focus();
                const clipboardData = new DataTransfer();
                clipboardData.setData('text/plain', text);
                const pasteEvent = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
                if (el.dispatchEvent(pasteEvent)) success = true;
            } catch (e) {}
        }
        
        if (!success) {
            try {
                el.focus();
                if (document.execCommand && document.execCommand('insertText', false, text)) success = true;
            } catch (e) {}
        }

        if (!success) {
            try {
                el.focus();
                const selection = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(el);
                selection.removeAllRanges();
                selection.addRange(range);
                
                if (window.InputEvent) {
                    const inputEvent = new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true });
                    if (el.dispatchEvent(inputEvent)) {
                        selection.deleteFromDocument();
                        const textNode = document.createTextNode(text);
                        range.insertNode(textNode);
                        range.setStartAfter(textNode);
                        selection.removeAllRanges();
                        selection.addRange(range);
                        success = true;
                    }
                }
            } catch (e) {}
        }

        if (!success) {
            el.textContent = text;
        }
    }

    // 4. Trigger framework events
    const events = ['input', 'change', 'keyup', 'blur'].map(e => new Event(e, { bubbles: true, cancelable: true }));
    events.forEach(evt => {
        try { el.dispatchEvent(evt); } catch (e) {}
    });

    return { ok: true, note: `typed text into ${tagName}` };
}

export async function pressKey(keyName, opaqueId = null, graph = null) {
    let target = document.activeElement;
    
    if (opaqueId) {
        const el = window.CYCLOPS.nodeFor(opaqueId);
        if (el) {
            el.focus();
            target = el;
        }
    }
    
    if (!target || target === document.body || target === document.documentElement) {
        const inputs = document.querySelectorAll('input, textarea, [contenteditable="true"]');
        for (let input of inputs) {
            const style = getComputedStyle(input);
            if (style.display !== 'none' && style.visibility !== 'hidden' && !input.disabled && !input.readOnly) {
                input.focus();
                target = input;
                break;
            }
        }
    }
    if (!target) target = document.body;

    const keyMapping = {
        'Enter': { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 },
        'Escape': { key: 'Escape', code: 'Escape', keyCode: 27, which: 27 },
        'Tab': { key: 'Tab', code: 'Tab', keyCode: 9, which: 9 },
        'Space': { key: ' ', code: 'Space', keyCode: 32, which: 32 },
        'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, which: 38 },
        'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40 }
    };
    const keyInfo = keyMapping[keyName] || { key: keyName, code: keyName, keyCode: keyName.charCodeAt(0), which: keyName.charCodeAt(0) };

    const opts = {
        key: keyInfo.key, code: keyInfo.code, keyCode: keyInfo.keyCode, which: keyInfo.which,
        bubbles: true, cancelable: true, composed: true
    };
    
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    if (keyName.length === 1) target.dispatchEvent(new KeyboardEvent('keypress', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));

    // Fallbacks
    if (keyName === 'Enter') {
        if (target.form) {
            target.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            if (target.form.submit) target.form.submit();
        } else if (target.tagName === 'BUTTON' || target.type === 'submit' || target.getAttribute('role') === 'button') {
            target.click();
        }
    } else if (keyName === 'Space' && (target.tagName === 'BUTTON' || target.getAttribute('role') === 'button')) {
        target.click();
    }

    return { ok: true, note: `pressed ${keyName} on ${target.tagName}` };
}
