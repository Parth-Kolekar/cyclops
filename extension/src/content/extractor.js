/**
 * Cyclops — Screen Graph extractor.
 *
 * Turns the live DOM into the structure the agent reasons about. This is the
 * primary sensor: the browser already knows every element's role, accessible
 * name and exact pixel rect, so we read that instead of OCR-ing a screenshot.
 * Vision only fills the gaps the DOM cannot explain (see `opaque_regions`).
 *
 * Content scripts are classic scripts, not ES modules, so everything hangs off
 * a single `window.CYCLOPS` namespace shared across the content/ files.
 */

window.CYCLOPS = window.CYCLOPS || {};

(() => {
  const C = window.CYCLOPS;

  /** Opaque id -> live DOM node. Never serialised, never leaves this page. */
  const NODE_MAP = new Map();
  C.nodeFor = (id) => NODE_MAP.get(id);
  C.allNodes = () => NODE_MAP;

  /** Everything the browser considers actionable, plus labelled/roled nodes. */
  const INTERACTIVE_SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea',
    '[role]', '[onclick]', '[tabindex]', 'summary', 'label',
  ].join(',');

  /** Regions the DOM cannot describe — these are the vision model's job. */
  const OPAQUE_SELECTOR = 'canvas, img, video, svg:not([aria-label]), embed, object, iframe';

  const MAX_ELEMENTS = 120;   // latency guard; unbounded lists confuse planners
  const MIN_AREA = 60;        // px², below this it isn't a real target
  const NORM_WIDTH = 1024;    // virtual viewport all coordinates map into

  // ------------------------------------------------------------- visibility

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }

  function intersectsViewport(r) {
    return r.w * r.h >= MIN_AREA &&
      r.y + r.h > 0 && r.y < window.innerHeight &&
      r.x + r.w > 0 && r.x < window.innerWidth;
  }

  function isRendered(el) {
    // aria-hidden is removed from the accessibility tree, so it isn't part of
    // what a screen reader — or this agent — should perceive.
    if (el.closest('[aria-hidden="true"]')) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    if (parseFloat(cs.opacity) < 0.05) return false;
    // position:fixed elements legitimately have no offsetParent
    if (el.offsetParent === null && cs.position !== 'fixed') return false;
    return true;
  }

  // ------------------------------------------------------ accessible naming

  /**
   * Accessible name resolution in the priority order browsers use.
   * Getting this right is most of the "element label accuracy" metric.
   */
  function accessibleName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria?.trim()) return aria.trim();

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText?.trim())
        .filter(Boolean).join(' ');
      if (text) return text;
    }

    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl?.innerText.trim()) return lbl.innerText.trim();
    }

    const wrapping = el.closest('label');
    if (wrapping && wrapping !== el && wrapping.innerText.trim()) {
      return wrapping.innerText.trim();
    }

    for (const attr of ['placeholder', 'title', 'alt']) {
      const v = el.getAttribute(attr);
      if (v?.trim()) return v.trim();
    }

    const own = ownText(el);
    if (own) return own.slice(0, 120);

    return el.getAttribute('name') || el.id || el.tagName.toLowerCase();
  }

  /** Collapsed innerText, used both for naming and for PII scanning later. */
  function ownText(el) {
    return (el.innerText || '').replace(/\s+/g, ' ').trim();
  }

  // ------------------------------------------------------------------ roles

  const INPUT_ROLE = {
    submit: 'button', button: 'button', reset: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider',
    file: 'file', color: 'colorpicker',
  };

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;

    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'label') return 'label';
    if (tag === 'input') return INPUT_ROLE[(el.type || 'text').toLowerCase()] || 'textbox';
    return 'text';
  }

  /** How likely the planner is to want this element. Feeds the ranking. */
  const ROLE_WEIGHT = {
    button: 1.0, textbox: 1.0, select: 1.0, checkbox: 0.9, radio: 0.9,
    link: 0.7, slider: 0.7, file: 0.7, tab: 0.7,
    label: 0.3, text: 0.25,
  };

  // ------------------------------------------------------------------- dedup

  function iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    if (!inter) return 0;
    return inter / (a.w * a.h + b.w * b.h - inter);
  }

  /**
   * A <button> wrapped in a clickable <div> is one target, not two. Where two
   * candidates cover essentially the same pixels, keep the inner one — that's
   * the node that actually handles the event.
   */
  function dedupeNested(cands) {
    const drop = new Set();
    for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        const a = cands[i], b = cands[j];
        if (drop.has(i) || drop.has(j)) continue;
        if (iou(a.rect, b.rect) <= 0.9) continue;
        if (a.el.contains(b.el)) drop.add(i);
        else if (b.el.contains(a.el)) drop.add(j);
      }
    }
    return cands.filter((_, i) => !drop.has(i));
  }

  // ----------------------------------------------------------------- ranking

  function score(cand) {
    const { rect } = cand;
    const area = Math.min(rect.w * rect.h, 200_000) / 200_000;

    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    const dx = (cx - window.innerWidth / 2) / window.innerWidth;
    const dy = (cy - window.innerHeight / 2) / window.innerHeight;
    const centrality = 1 - Math.min(1, Math.hypot(dx, dy));

    const weight = ROLE_WEIGHT[cand.role] ?? 0.4;
    return (0.25 + 0.75 * area) * (0.4 + 0.6 * centrality) * weight;
  }

  // ----------------------------------------------------- page-kind heuristic

  /**
   * Cheap DOM-signal guess at what kind of page this is. Step 4 replaces this
   * with the on-device ViT classifier; the field and its consumers stay put.
   */
  function classifyPage() {
    const inputs = [...document.querySelectorAll('input:not([type=hidden]), select, textarea')];
    const hasPassword = inputs.some((i) => i.type === 'password');
    const text = (document.body?.innerText || '').toLowerCase().slice(0, 6000);
    const has = (...words) => words.some((w) => text.includes(w));

    let kind = 'unknown', conf = 0.4;

    if (hasPassword && inputs.length <= 4) { kind = 'login'; conf = 0.9; }
    else if (has('cvv', 'card number', 'checkout', 'place order', 'payment method')) { kind = 'checkout'; conf = 0.8; }
    else if (inputs.length >= 4) { kind = 'form'; conf = 0.75; }
    else if (document.querySelectorAll('table tr').length >= 4) { kind = 'table'; conf = 0.7; }
    else if (has('dashboard', 'overview', 'analytics')) { kind = 'dashboard'; conf = 0.6; }
    else if (document.querySelector('article') || (document.body?.innerText || '').length > 2500) { kind = 'article'; conf = 0.6; }
    else if (has('results for', 'search results')) { kind = 'search_results'; conf = 0.6; }

    return { kind, kind_confidence: conf, kind_source: 'heuristic' };
  }

  // --------------------------------------------------------------- pruning

  /**
   * A <label> that names a field we already emitted is redundant — the field
   * carries that text as its accessible name. Emitting both doubles the
   * element count and gives the planner two ids for one thing.
   */
  function isConsumedLabel(el) {
    if (el.tagName.toLowerCase() !== 'label') return false;
    const forId = el.getAttribute('for');
    if (forId && document.getElementById(forId)) return true;
    return !!el.querySelector('input, select, textarea');
  }

  /** Blocks that contain other blocks aren't text leaves. Inline markup is. */
  const BLOCK_CHILD = [
    'div', 'p', 'section', 'article', 'aside', 'header', 'footer', 'nav',
    'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'form', 'fieldset',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dl', 'dd', 'dt', 'pre', 'blockquote',
    'input', 'select', 'textarea', 'button',
  ].join(',');

  // ------------------------------------------------------------------ main

  /**
   * All coordinates leave here in a virtual 1024px-wide viewport. That removes
   * device pixel ratio and browser zoom as sources of redaction misalignment,
   * and lets server-returned coordinates map back with one multiply.
   */
  function normaliser() {
    const scale = NORM_WIDTH / Math.max(1, window.innerWidth);
    return (r) => [
      +(r.x * scale).toFixed(1),
      +(r.y * scale).toFixed(1),
      +(r.w * scale).toFixed(1),
      +(r.h * scale).toFixed(1),
    ];
  }

  function extract() {
    const t0 = performance.now();
    NODE_MAP.clear();
    const norm = normaliser();

    // ---- 1. gather candidates
    const seen = new Set();
    let cands = [];

    const consider = (el) => {
      if (seen.has(el)) return;
      seen.add(el);
      if (isConsumedLabel(el)) return;
      if (!isRendered(el)) return;
      const rect = rectOf(el);
      if (!intersectsViewport(rect)) return;
      cands.push({ el, rect, role: roleOf(el) });
    };

    document.querySelectorAll(INTERACTIVE_SELECTOR).forEach(consider);

    // Leaf text nodes: the planner needs page content, and Step 2's PII
    // detectors need somewhere to look.
    for (const el of document.querySelectorAll('p, span, td, th, li, h1, h2, h3, h4, dd, dt, div, figcaption')) {
      if (seen.has(el)) continue;
      if (el.querySelector(BLOCK_CHILD)) continue;   // text leaves only
      const t = ownText(el);
      if (t.length < 2 || t.length > 300) continue;
      consider(el);
    }

    // ---- 2. dedupe, rank, cap
    //
    // A row like `<div><span>Aadhaar</span><span>4321…</span></div>` yields
    // three text candidates, and the outer one repeats the inner ones. Keep
    // only the innermost, or every value gets detected — and counted — twice.
    const rawCandidates = cands.length;
    const textCands = cands.filter((c) => c.role === 'text');
    cands = cands.filter((c) =>
      c.role !== 'text' ||
      !textCands.some((o) => o.el !== c.el && c.el.contains(o.el))
    );

    let kept = dedupeNested(cands);
    const afterDedupe = kept.length;
    kept.forEach((c) => { c.score = score(c); });
    kept.sort((a, b) => b.score - a.score);
    const overflow = Math.max(0, kept.length - MAX_ELEMENTS);
    kept = kept.slice(0, MAX_ELEMENTS);

    // Restore document order so the planner reads the page top-to-bottom.
    kept.sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x));

    // ---- 3. serialise
    const elements = kept.map((c, i) => {
      const id = `e${i}`;
      NODE_MAP.set(id, c.el);
      const el = c.el;
      const tag = el.tagName.toLowerCase();
      const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
      
      // Engineer 2: Extract rich DOM metadata for the backend
      const html_id = el.id || undefined;
      let html_class = undefined;
      if (typeof el.className === 'string' && el.className.trim()) {
        html_class = el.className.trim();
      } else if (el.className && el.className.baseVal) {
        html_class = el.className.baseVal.trim();
      }
      const placeholder = el.getAttribute?.('placeholder') || undefined;
      const aria_label = el.getAttribute?.('aria-label') || undefined;
      const html_role = el.getAttribute?.('role') || undefined;

      return {
        id,
        role: c.role,
        label: accessibleName(el),
        text: c.role === 'text' ? ownText(el).slice(0, 300) : undefined,
        value: isField ? String(el.value ?? '') : undefined,
        bbox: norm(c.rect),
        visible: true,
        enabled: !el.disabled,
        focused: document.activeElement === el,
        input_type: tag === 'input' ? (el.type || 'text') : undefined,
        autocomplete: el.getAttribute?.('autocomplete') || undefined,
        // Enriched HTML metadata
        html_id,
        html_class,
        placeholder,
        aria_label,
        html_role,
        // A planner can't choose from a dropdown it can't see the contents of.
        options: tag === 'select'
          ? [...el.options].map((o) => o.text.trim()).filter(Boolean).slice(0, 40)
          : undefined,
        source: 'dom',
      };
    });

    // ---- 4. regions the DOM cannot explain
    const opaque_regions = [];
    for (const el of document.querySelectorAll(OPAQUE_SELECTOR)) {
      if (!isRendered(el)) continue;
      const r = rectOf(el);
      if (!intersectsViewport(r)) continue;
      opaque_regions.push({
        tag: el.tagName.toLowerCase(),
        bbox: norm(r),
        described: !!(el.getAttribute('alt') || el.getAttribute('aria-label')),
      });
      if (opaque_regions.length >= 30) break;
    }

    return {
      schema: 'cyclops.sg.v1',
      captured_at: Date.now(),
      page: {
        url_host: location.host,
        title: document.title,
        ...classifyPage(),
      },
      viewport: {
        w: window.innerWidth,
        h: window.innerHeight,
        scroll_x: Math.round(window.scrollX),
        scroll_y: Math.round(window.scrollY),
        dpr: window.devicePixelRatio,
        norm_width: NORM_WIDTH,
        norm_scale: +(NORM_WIDTH / Math.max(1, window.innerWidth)).toFixed(4),
      },
      elements,
      opaque_regions,
      stats: {
        candidates: rawCandidates,
        merged_by_dedupe: rawCandidates - afterDedupe,
        emitted: elements.length,
        dropped_by_cap: overflow,
        extract_ms: +(performance.now() - t0).toFixed(1),
      },
    };
  }

  C.extract = extract;
  C.iou = iou;
  C.getNode = (id) => NODE_MAP.get(id); // Engineer 2: Exported for isTopElement
})();
