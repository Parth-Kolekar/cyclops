/**
 * Ported from browser-automation/extension/tools/navigation-tools.js
 */

// Navigating destroys this content script, and with it the pending
// sendResponse — the caller would see "message channel closed" instead of a
// result. Defer by a tick so the answer is already on its way out.
function afterReply(fn) {
    setTimeout(fn, 50);
}

export async function navigate(url) {
    if (!url) return { ok: false, error: 'navigate without a destination' };
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }
    afterReply(() => { window.location.href = url; });
    return { ok: true, note: `navigating to ${url}`, navigated: true };
}

export async function goBack() {
    afterReply(() => window.history.back());
    return { ok: true, note: `navigating back`, navigated: true };
}

export async function reloadPage() {
    afterReply(() => window.location.reload());
    return { ok: true, note: `reloading page`, navigated: true };
}

export async function scrollPage(direction, amount = null) {
    const scrollAmount = amount ?? Math.round(window.innerHeight * 0.8);
    const map = {
        down: () => window.scrollBy({ top: scrollAmount, behavior: 'smooth' }),
        up: () => window.scrollBy({ top: -scrollAmount, behavior: 'smooth' }),
        left: () => window.scrollBy({ left: -scrollAmount, behavior: 'smooth' }),
        right: () => window.scrollBy({ left: scrollAmount, behavior: 'smooth' }),
        top: () => window.scrollTo({ top: 0, behavior: 'smooth' }),
        bottom: () => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
    };
    
    if (map[direction]) {
        map[direction]();
        
        // Wait for smooth scroll to finish
        await new Promise(r => setTimeout(r, 600));
        
        return { ok: true, note: `scrolled ${direction} ${scrollAmount}px` };
    }
    return { ok: false, error: `Invalid scroll direction: ${direction}` };
}
