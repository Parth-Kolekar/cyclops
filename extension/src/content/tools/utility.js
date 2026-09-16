export async function wait(seconds) {
    const ms = seconds * 1000;
    await new Promise(resolve => setTimeout(resolve, ms));
    return { ok: true, note: `waited ${seconds} seconds` };
}

export async function extractPageText() {
    let text = "";
    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode: (node) => {
                if (node.parentElement && ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.parentElement.tagName)) {
                    return NodeFilter.FILTER_REJECT;
                }
                // Only accept visible nodes
                if (node.parentElement) {
                    const style = window.getComputedStyle(node.parentElement);
                    if (style.display === 'none' || style.visibility === 'hidden') {
                        return NodeFilter.FILTER_REJECT;
                    }
                }
                return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            }
        }
    );

    let node;
    while ((node = walker.nextNode())) {
        text += node.nodeValue.trim() + " ";
    }
    
    // Truncate if too long to avoid token explosion
    if (text.length > 50000) {
        text = text.substring(0, 50000) + "... (truncated)";
    }
    
    return { ok: true, note: `extracted ${text.length} chars`, text: text.trim() };
}

export async function executeJs(code) {
    // WARNING: Strict last resort. Do not expose vault data to this context.
    try {
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const executor = new AsyncFunction(code);
        const result = await executor();
        return { ok: true, note: `JS execution completed`, result: result };
    } catch (e) {
        return { ok: false, error: `JS execution failed: ${e.message}` };
    }
}
