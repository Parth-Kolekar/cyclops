/**
 * Cyclops — PII detection.
 *
 * Runs in the content script, where we still have the DOM. That matters: for
 * a number sitting inside a paragraph we can build a Range over just those
 * characters and get the exact pixel rectangle, instead of blacking out the
 * whole paragraph. Tight boxes are the redaction-precision metric.
 *
 * Three detector families, unioned then deduplicated:
 *   (a) structural — regex plus a real checksum
 *   (b) semantic   — DOM type signals (password fields, autocomplete, labels)
 *   (c) learned    — NER / vision. Step 4.
 *
 * Threshold policy is deliberately recall-favouring. A privacy tool that leaks
 * 5% of PII is worthless; one that over-redacts 5% is mildly annoying.
 */

window.CYCLOPS = window.CYCLOPS || {};

(() => {
  const C = window.CYCLOPS;

  // ------------------------------------------------------------ checksums

  /**
   * Verhoeff — the checksum Aadhaar actually uses. Catches all single-digit
   * errors and all adjacent transpositions, which is why a random 12-digit
   * order number almost never passes. This one function is most of our
   * precision on the decoy pages.
   */
  const VERHOEFF_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
  ];
  const VERHOEFF_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
  ];

  function verhoeff(digits) {
    let c = 0;
    const rev = digits.split('').reverse();
    for (let i = 0; i < rev.length; i++) {
      c = VERHOEFF_D[c][VERHOEFF_P[i % 8][+rev[i]]];
    }
    return c === 0;
  }

  /** Luhn — every real payment card passes this. */
  function luhn(digits) {
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = +digits[i];
      if (alt) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
      alt = !alt;
    }
    return digits.length >= 13 && sum % 10 === 0;
  }

  /** GSTIN check digit, base-36 weighted alternating 1,2. */
  const GST_ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function gstinValid(code) {
    if (code.length !== 15) return false;
    let sum = 0;
    for (let i = 0; i < 14; i++) {
      const v = GST_ALPHA.indexOf(code[i]);
      if (v < 0) return false;
      const p = v * (i % 2 ? 2 : 1);
      sum += Math.floor(p / 36) + (p % 36);
    }
    return GST_ALPHA[(36 - (sum % 36)) % 36] === code[14];
  }

  /** PAN's 4th character encodes holder type; anything else is a false hit. */
  const PAN_HOLDER = new Set(['P', 'C', 'H', 'F', 'A', 'T', 'B', 'L', 'J', 'G']);

  const PSP_HANDLES = new Set([
    'okhdfcbank', 'okicici', 'oksbi', 'okaxis', 'ybl', 'paytm', 'upi',
    'apl', 'axl', 'ibl', 'airtel', 'freecharge',
  ]);

  // ------------------------------------------------------ structural rules
  //
  // Order matters. Aadhaar is tried before phone so a 12-digit Aadhaar is not
  // shredded into a 10-digit mobile; overlapping matches resolve by priority.

  const RULES = [
    {
      kind: 'aadhaar',
      priority: 100,
      re: /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g,
      validate: (m) => verhoeff(m.replace(/\D/g, '')),
      context: ['aadhaar', 'aadhar', 'uid', 'uidai'],
    },
    {
      kind: 'card',
      priority: 95,
      re: /\b(?:\d[ -]?){13,19}\b/g,
      validate: (m) => luhn(m.replace(/\D/g, '')),
      context: ['card', 'credit', 'debit', 'visa', 'mastercard', 'rupay'],
    },
    {
      kind: 'gstin',
      priority: 90,
      re: /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/g,
      validate: gstinValid,
      context: ['gst', 'gstin', 'tax'],
    },
    {
      kind: 'pan',
      priority: 85,
      re: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
      validate: (m) => PAN_HOLDER.has(m[3]),
      context: ['pan', 'permanent account'],
    },
    {
      kind: 'ifsc',
      priority: 80,
      re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
      validate: (m) => m[4] === '0',
      context: ['ifsc', 'bank', 'branch'],
    },
    {
      kind: 'passport',
      priority: 75,
      re: /\b[A-PR-WY][1-9]\d\s?\d{4}[1-9]\b/g,
      validate: () => true,
      context: ['passport'],
      needsContext: true,   // format alone is far too loose
    },
    {
      kind: 'email',
      priority: 70,
      re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
      validate: (m) => /\.[a-z]{2,}$/i.test(m),
    },
    {
      kind: 'upi_vpa',
      priority: 65,
      re: /\b[\w.\-]{3,}@([a-z]{3,})\b/g,
      validate: (m) => PSP_HANDLES.has(m.split('@')[1]?.toLowerCase()),
    },
    {
      kind: 'phone',
      priority: 60,
      re: /(?:\+?91[-\s]?)?\b[6-9]\d{9}\b/g,
      validate: (m) => {
        const d = m.replace(/\D/g, '').slice(-10);
        return d.length === 10 && /[6-9]/.test(d[0]);
      },
      context: ['phone', 'mobile', 'contact', 'tel', 'whatsapp'],
    },
    {
      kind: 'dob',
      priority: 55,
      re: /\b(?:\d{1,2}[\/\-.]\d{1,2}[\/\-.](?:19|20)\d{2}|(?:19|20)\d{2}[\/\-.]\d{1,2}[\/\-.]\d{1,2})\b/g,
      validate: (m) => {
        const y = +(m.match(/(?:19|20)\d{2}/)?.[0] ?? 0);
        return y >= 1900 && y <= new Date().getFullYear();
      },
      context: ['dob', 'birth', 'born'],
      needsContext: true,   // dates are everywhere; only flag with a cue
    },
  ];

  /**
   * Confidence policy, stated once so it can go on a slide:
   *   checksum passes            -> 0.98, detector "checksum"
   *   pattern only, but a nearby
   *   label names the kind       -> 0.75, detector "regex+context"
   *   pattern only, no context   -> dropped
   * That last line is what rejects order numbers and tracking IDs.
   */
  function scanText(text, context = '') {
    if (!text) return [];
    const ctx = context.toLowerCase();
    const hits = [];

    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(text)) !== null) {
        const raw = m[0].trim();
        const passes = rule.validate(raw);
        const hasContext = !!rule.context?.some((w) => ctx.includes(w));

        let confidence = 0;
        let detector = 'regex';
        if (passes && !rule.needsContext) { confidence = 0.98; detector = 'checksum'; }
        else if (passes && hasContext) { confidence = 0.9; detector = 'checksum'; }
        else if (hasContext) { confidence = 0.75; detector = 'regex+context'; }
        else continue;   // shape-only match with no supporting cue — decoy

        hits.push({
          kind: rule.kind,
          value: raw,
          start: m.index,
          end: m.index + m[0].length,
          confidence,
          detector,
          priority: rule.priority,
        });
      }
    }

    return resolveOverlaps(hits);
  }

  /** A 12-digit Aadhaar also looks like a 10-digit phone. Highest rule wins. */
  function resolveOverlaps(hits) {
    hits.sort((a, b) => b.priority - a.priority || a.start - b.start);
    const kept = [];
    for (const h of hits) {
      const clash = kept.some((k) => h.start < k.end && k.start < h.end);
      if (!clash) kept.push(h);
    }
    return kept.sort((a, b) => a.start - b.start);
  }

  // --------------------------------------------------------- DOM signals
  // Zero cost, perfect precision, and it catches what regex cannot: an empty
  // field that is *going* to hold an Aadhaar has no text to match on.

  const AUTOCOMPLETE_KIND = {
    'cc-number': 'card', 'cc-csc': 'card', 'cc-exp': 'card',
    tel: 'phone', 'tel-national': 'phone',
    email: 'email',
    'street-address': 'address', 'address-line1': 'address', 'postal-code': 'address',
    name: 'person_name', 'given-name': 'person_name', 'family-name': 'person_name',
    bday: 'dob', 'one-time-code': 'otp',
    'current-password': 'password', 'new-password': 'password',
  };

  const LABEL_LEXICON = [
    [['aadhaar', 'aadhar', 'uidai', 'uid number'], 'aadhaar'],
    [['pan number', 'pan card', 'permanent account'], 'pan'],
    [['passport'], 'passport'],
    [['ifsc'], 'ifsc'],
    [['gstin', 'gst number'], 'gstin'],
    [['cvv', 'card number', 'credit card', 'debit card'], 'card'],
    [['upi', 'vpa'], 'upi_vpa'],
    [['otp', 'one time password', 'verification code'], 'otp'],
    [['date of birth', 'dob', 'birth date'], 'dob'],
    [['address', 'street', 'pin code', 'postal'], 'address'],
    [['mobile', 'phone', 'contact number'], 'phone'],
    [['email', 'e-mail'], 'email'],
    [['full name', 'applicant name', 'your name'], 'person_name'],
  ];

  const INPUT_TYPE_KIND = { password: 'password', email: 'email', tel: 'phone' };

  /**
   * What kind of PII is this field *for*? Independent of whether it currently
   * holds any. An empty "Aadhaar number" box still needs to be recognised, so
   * the planner can ask for [AADHAAR_1] and the vault can refuse anything else.
   */
  function expectedKind(el, label) {
    const tag = el.tagName?.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return null;

    const type = (el.type || '').toLowerCase();
    if (INPUT_TYPE_KIND[type]) return INPUT_TYPE_KIND[type];

    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (AUTOCOMPLETE_KIND[ac]) return AUTOCOMPLETE_KIND[ac];

    const hay = `${label} ${el.name || ''} ${el.id || ''}`.toLowerCase();
    for (const [words, kind] of LABEL_LEXICON) {
      if (words.some((w) => hay.includes(w))) return kind;
    }
    return null;
  }

  // ------------------------------------------------------------ geometry

  /**
   * Pixel rectangle for a substring inside an element. Walks the text nodes
   * and builds a Range over exactly the matched characters — so "Aadhaar:
   * 2345 6789 0128" blacks out only the digits, not the label.
   * Falls back to the element box if the match straddles nodes.
   */
  function rectForSubstring(el, needle) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.data.indexOf(needle);
      if (idx === -1) continue;
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + needle.length);
      const r = range.getBoundingClientRect();
      range.detach?.();
      if (r.width > 0 && r.height > 0) return r;
    }
    return el.getBoundingClientRect();
  }

  /** Over-covering costs a little IoU; under-covering is a privacy failure. */
  const DILATE = 4;

  function dilate(r, scale) {
    return [
      +((r.x - DILATE) * scale).toFixed(1),
      +((r.y - DILATE) * scale).toFixed(1),
      +((r.width + DILATE * 2) * scale).toFixed(1),
      +((r.height + DILATE * 2) * scale).toFixed(1),
    ];
  }

  /**
   * Text surrounding an element — its row, cell or paragraph. Cheap, and it is
   * what turns an ambiguous string into a confident classification.
   */
  function nearbyText(node) {
    const parent = node.parentElement;
    if (!parent) return '';
    let text = (parent.innerText || '').slice(0, 200);
    // A table cell's meaning usually lives in the row, one level further out.
    if (text.length < 40 && parent.parentElement) {
      text += ` ${(parent.parentElement.innerText || '').slice(0, 200)}`;
    }
    return text.replace(/\s+/g, ' ');
  }

  // ---------------------------------------------------------------- main

  /**
   * Annotate a Screen Graph in place and return the findings.
   *
   * A "finding" is PII that is actually present and must be destroyed before
   * the payload leaves. A field that merely *expects* PII is not a finding —
   * there is nothing to redact — but it is marked so the vault can enforce
   * kind compatibility when the server later asks for it to be filled.
   */
  function annotate(graph, nodeFor) {
    const t0 = performance.now();
    const findings = [];
    const scale = graph.viewport.norm_scale;

    for (const el of graph.elements) {
      const node = nodeFor(el.id);
      if (!node) continue;

      // (b) semantic — what is this field for?
      const expects = expectedKind(node, el.label);
      if (expects) el.pii_expects = expects;

      // A password field is PII regardless of what it contains.
      if (expects === 'password' && (el.value || '').length) {
        findings.push({
          element_id: el.id,
          kind: 'password',
          value: el.value,
          bbox: dilate(node.getBoundingClientRect(), scale),
          confidence: 1,
          detector: 'dom_type',
          where: 'value',
        });
        continue;
      }

      // (a) structural — scan the strings this element actually carries.
      //
      // Context has to come from the neighbourhood, not just the element. A
      // date sitting alone in a <span> is only recognisable as a birth date
      // because the cell beside it says "Date of birth".
      const context = `${el.label || ''} ${el.pii_expects || ''} ${nearbyText(node)}`;

      for (const [where, text] of [['value', el.value], ['text', el.text]]) {
        if (!text) continue;
        for (const hit of scanText(text, context)) {
          findings.push({
            element_id: el.id,
            kind: hit.kind,
            value: hit.value,
            bbox: where === 'text'
              ? dilate(rectForSubstring(node, hit.value), scale)
              : dilate(node.getBoundingClientRect(), scale),
            confidence: hit.confidence,
            detector: hit.detector,
            where,
          });
        }
      }
    }

    graph.pii = {
      findings,
      scan_ms: +(performance.now() - t0).toFixed(1),
      detectors: ['regex', 'checksum', 'dom_type'],
    };
    return findings;
  }

  C.pii = { annotate, scanText, expectedKind, verhoeff, luhn, gstinValid };
})();
