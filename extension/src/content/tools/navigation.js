/**
 * Ported from browser-automation/extension/tools/navigation-tools.js
 */

export async function navigate(url) {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }
    window.location.href = url;
    return { ok: true, note: `navigating to ${url}` };
}

export async function goBack() {
    window.history.back();
    return { ok: true, note: `navigating back` };
}

export async function reloadPage() {
    window.location.reload();
    return { ok: true, note: `reloading page` };
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
