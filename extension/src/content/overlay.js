/**
 * Cyclops — "what the agent sees" overlay.
 *
 * Draws the Screen Graph back onto the live page: one box per extracted
 * element, tagged with the opaque id the server will use to refer to it.
 * This is the demo artefact for the visual-context accuracy claim — instead of
 * asserting the agent understands the page, you show it.
 */

window.CYCLOPS = window.CYCLOPS || {};

(() => {
  const C = window.CYCLOPS;
  const HOST_ID = '__cyclops_overlay__';

  const COLOURS = {
    button: '#22d3ee',
    textbox: '#34d399',
    select: '#a78bfa',
    checkbox: '#a78bfa',
    radio: '#a78bfa',
    link: '#fbbf24',
    text: '#64748b',
    label: '#64748b',
    opaque: '#f472b6',
  };

  function teardown() {
    document.getElementById(HOST_ID)?.remove();
  }

  /**
   * Rendered inside a shadow root so the page's own CSS can't restyle it and
   * our CSS can't leak into the page — important, because a redaction demo
   * that visually alters the page under test is not a convincing one.
   */
  function makeHost() {
    teardown();
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(host);

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      .box {
        position: fixed;
        border: 1.5px solid var(--c);
        background: color-mix(in srgb, var(--c) 8%, transparent);
        border-radius: 3px;
        box-sizing: border-box;
      }
      .tag {
        position: absolute; top: -15px; left: -1px;
        font: 600 9px/1.4 ui-monospace, monospace;
        letter-spacing: .3px;
        background: var(--c); color: #06121a;
        padding: 0 4px; border-radius: 3px 3px 0 0;
        white-space: nowrap;
      }
      .box.opaque { border-style: dashed; }
      .panel {
        position: fixed; top: 12px; right: 12px;
        background: #0b0f14ee; color: #e5e7eb;
        border: 1px solid #1f2937; border-radius: 10px;
        padding: 10px 12px; min-width: 190px;
        font: 11px/1.5 ui-sans-serif, system-ui, sans-serif;
        box-shadow: 0 8px 28px #0009;
        backdrop-filter: blur(6px);
      }
      .panel h4 {
        margin: 0 0 6px; font-size: 10px; letter-spacing: .9px;
        text-transform: uppercase; color: #22d3ee;
      }
      .panel .r { display: flex; justify-content: space-between; gap: 12px; }
      .panel .r span:last-child { color: #8b98a9; font-variant-numeric: tabular-nums; }
      .legend { margin-top: 8px; padding-top: 7px; border-top: 1px solid #1f2937;
                display: flex; flex-wrap: wrap; gap: 4px 9px; }
      .legend i { display: inline-flex; align-items: center; gap: 4px;
                  font-style: normal; color: #8b98a9; font-size: 10px; }
      .legend i::before { content: ''; width: 8px; height: 8px; border-radius: 2px;
                          background: var(--c); }
    </style>`;
    return root;
  }

  function drawBox(root, bbox, scale, colour, tag, extraClass = '') {
    const [nx, ny, nw, nh] = bbox;
    const box = document.createElement('div');
    box.className = `box ${extraClass}`;
    box.style.setProperty('--c', colour);
    box.style.left = `${nx / scale}px`;
    box.style.top = `${ny / scale}px`;
    box.style.width = `${nw / scale}px`;
    box.style.height = `${nh / scale}px`;
    box.innerHTML = `<span class="tag"></span>`;
    box.querySelector('.tag').textContent = tag;
    root.appendChild(box);
  }

  /** @param graph the Screen Graph returned by extractor.extract() */
  function show(graph) {
    const root = makeHost();
    const scale = graph.viewport.norm_scale; // normalised px -> CSS px

    for (const el of graph.elements) {
      const colour = COLOURS[el.role] || COLOURS.text;
      const label = el.label ? ` ${el.label.slice(0, 22)}` : '';
      drawBox(root, el.bbox, scale, colour, `${el.id} ${el.role}${label}`);
    }

    for (const r of graph.opaque_regions) {
      drawBox(root, r.bbox, scale, COLOURS.opaque, `${r.tag} · needs vision`, 'opaque');
    }

    const panel = document.createElement('div');
    panel.className = 'panel';
    const roles = new Set(graph.elements.map((e) => e.role));
    panel.innerHTML = `
      <h4>Cyclops — screen graph</h4>
      <div class="r"><span>page kind</span><span>${graph.page.kind} · ${(graph.page.kind_confidence * 100) | 0}%</span></div>
      <div class="r"><span>elements</span><span>${graph.elements.length}</span></div>
      <div class="r"><span>opaque regions</span><span>${graph.opaque_regions.length}</span></div>
      <div class="r"><span>merged (nested)</span><span>${graph.stats.merged_by_dedupe}</span></div>
      <div class="r"><span>extract time</span><span>${graph.stats.extract_ms} ms</span></div>
      <div class="legend">${
        [...roles].filter((r) => COLOURS[r]).map(
          (r) => `<i style="--c:${COLOURS[r]}">${r}</i>`
        ).join('')
      }${graph.opaque_regions.length ? `<i style="--c:${COLOURS.opaque}">opaque</i>` : ''}</div>`;
    root.appendChild(panel);

    // Boxes are fixed-position and computed from viewport coords, so any
    // scroll or resize invalidates them. Simplest correct answer: drop them.
    const kill = () => hide();
    window.addEventListener('scroll', kill, { once: true, passive: true });
    window.addEventListener('resize', kill, { once: true });
  }

  function hide() { teardown(); }
  function isShown() { return !!document.getElementById(HOST_ID); }

  C.overlay = { show, hide, isShown };
})();
