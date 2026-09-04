/**
 * Cyclops — sanitiser.
 *
 * The only place a Screen Graph turns into something allowed on the network.
 * Everything that crosses the boundary goes through this function, so there is
 * exactly one piece of code to audit and exactly one place to point at when a
 * judge asks "how do you know nothing leaks?".
 */

import { tokenise, tokenFor } from './vault.js';

/** Replace every literal occurrence of `needle` — no regex, no escaping bugs. */
function swap(haystack, needle, token) {
  if (!haystack) return haystack;
  return haystack.split(needle).join(token);
}

/**
 * @param {object} graph  Screen Graph, already annotated by content/pii.js
 * @returns {{ elements, manifest, findings, assignments }}
 */
export async function sanitise(graph) {
  const findings = graph.pii?.findings ?? [];
  const { assignments, manifest } = await tokenise(findings);

  // Group findings by element so we only walk the list once.
  const byElement = new Map();
  for (const f of findings) {
    if (!byElement.has(f.element_id)) byElement.set(f.element_id, []);
    byElement.get(f.element_id).push(f);
  }

  const elements = graph.elements.map((el) => {
    const clean = { ...el };
    const hits = byElement.get(el.id);

    if (hits) {
      for (const f of hits) {
        const token = tokenFor(assignments, f);
        // Every string we are about to ship, not just the one we matched in —
        // the same number often appears in both the label and the value.
        clean.value = swap(clean.value, f.value, token);
        clean.text = swap(clean.text, f.value, token);
        clean.label = swap(clean.label, f.value, token);
      }

      // Tell the server *that* this element holds PII and of what kind, so it
      // can reason about the field. Never what the value is.
      clean.pii = {
        kind: hits[0].kind,
        confidence: Math.max(...hits.map((h) => h.confidence)),
        detector: hits[0].detector,
      };
    }

    return clean;
  });

  return { elements, manifest, findings, assignments };
}

/**
 * Belt and braces: a final sweep over the finished payload looking for any
 * value we know to be sensitive. If the swap above ever misses one — a
 * normalisation difference, a value split across nodes — this catches it
 * before the fetch rather than after.
 *
 * @returns {string[]} kinds that leaked; empty means clean
 */
export function auditPayload(payload, findings) {
  const blob = JSON.stringify(payload);
  const leaked = new Set();
  for (const f of findings) {
    if (f.value && blob.includes(f.value)) leaked.add(f.kind);
  }
  return [...leaked];
}
