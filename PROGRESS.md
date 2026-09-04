# Cyclops — Progress Log

Plain-language record of what has actually been built, step by step.
One section per commit. If code from an earlier step gets replaced, that
section is updated or removed so this file never describes something that
no longer exists.

**What Cyclops is:** a browser extension that reads the page you're on, blacks
out anything sensitive (Aadhaar, phone, face, password) *before* anything
leaves your laptop, sends only the safe version to a server, and carries out
whatever the server tells it to do — click this, type that.

---

## Step 0 — Skeleton and the dumb loop ✅

**Goal:** prove the plumbing works. Extension talks to server, server talks
back, extension does what it's told. No AI, no privacy filter yet — just the
pipe.

### What we built

**The extension** (`extension/`) — plain JavaScript, no build step. You load
the folder straight into Chrome.

- `manifest.json` — tells Chrome what the extension is and what it's allowed
  to touch. Right now: the current tab, and our local server on port 8000.
- `src/content/` — the part that lives inside the webpage. It does two things:
  **look** (walk the page and list every button, text box, link, with a made-up
  id like `e0`, `e1`) and **act** (click or type into whichever id the server
  names). *Step 1 split this into proper modules — see below.*
- `src/background/sw.js` — the conductor. Runs the loop:
  *ask the page what's on it → ask the server what to do → tell the page to do
  it → repeat*, up to 8 steps or until the server says "done".
- `src/popup/` — the little window you get when you click the extension icon.
  A box to type your goal, Run/Stop buttons, a live step-by-step trace with
  timings, and a dot that turns green when the server is reachable.
- `src/lib/config.js` — one place for the server URL and message names.

**The server** (`server/`) — Python + FastAPI.

- `app/schema.py` — the agreed shape of the data. What the extension sends
  (page description) and what the server may send back. The reply is limited to
  **seven verbs**: click, fill, select, scroll, navigate, ask_user, done. This
  cap is deliberate — it keeps the agent predictable and safe.
- `app/planner/stub.py` — a fake "brain" made of three rules: fill the first
  empty text box, then click the first button, then say done. No AI at all.
  Step 3 swaps this for a real LLM without changing anything around it.
- `app/main.py` — the three endpoints: `/v1/plan` (the real one),
  `/v1/health`, `/v1/metrics`.

**The test page** (`demo/test-page.html`) — a form we can watch the agent
drive. *Step 1 expanded it; see below.*

### Design decision baked in from day one

The server **never sees a CSS selector**. It only ever says `click e12`. The
map from `e12` to the real element stays inside the page and is never sent
anywhere. This means a malicious or confused server can't make the extension
click something arbitrary — and it makes the payload smaller.

### How to run it

```bash
# 1. server
cd server
python -m venv .venv
.venv\Scripts\activate            # Windows;  source .venv/bin/activate on Mac/Linux
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# 2. demo page (a separate terminal, from the repo root)
python -m http.server 5500
# then open http://localhost:5500/demo/test-page.html

# 3. extension
# Chrome -> chrome://extensions -> Developer mode ON
#        -> "Load unpacked" -> pick the `extension` folder
```

Click the Cyclops icon on the demo page, type a goal, hit **Run**. The form
fills itself and submits.

### Verified

Server tested directly with a sample payload — it correctly returns
`fill → click → done` across three steps in sequence.

---

## Step 1 — Real perception (the Screen Graph) ✅

**Goal:** make the agent genuinely *understand* the page, and be able to prove
it on screen. This is the biggest single scoring line in the rubric (25% —
"accuracy of visual context from screen").

### What we built

**The content script became three proper modules** instead of one file:

| File | Job |
|---|---|
| `content/extractor.js` | Reads the page and builds the **Screen Graph** |
| `content/executor.js` | Carries out click / type / choose-from-dropdown / scroll |
| `content/overlay.js` | Draws the boxes showing what the agent sees |
| `content/index.js` | Just routes messages now |

**The Screen Graph** is the agent's picture of the page. Getting it right is
mostly about six unglamorous details:

1. **Proper labels.** For each field we work out its real name the same way a
   screen reader would — check `aria-label`, then the linked `<label>`, then the
   placeholder, then the title, then the visible text. This is why "Full name"
   comes out as *Full name* and not `input#fullname`.
2. **Only what's actually on screen.** Hidden, transparent, off-screen, or
   tiny (under 60px²) elements are dropped. So are elements marked
   `aria-hidden`, because a screen reader ignores those too.
3. **No double-counting.** A button wrapped in a clickable div is *one* thing,
   not two. Where two boxes cover essentially the same pixels we keep the inner
   one — that's the element that actually handles the click. Same for a
   `<label>` that just names a field we already listed.
4. **A hard cap of 120 elements**, ranked by size × how central they are ×
   how likely the agent is to want them. Unbounded lists are the main cause of
   slow, confused agents.
5. **Normalised coordinates.** Every box is expressed against a virtual
   1024-pixel-wide screen instead of real pixels. This makes screen size, zoom
   level and retina displays stop mattering — which is exactly what stops the
   black boxes from landing in the wrong place in Step 2.
6. **Flagging what it can't read.** Anything drawn as pixels — `<canvas>`,
   images, video, iframes — gets listed separately as an "opaque region". These
   are the only places we'll later need to spend money on vision. Typically
   that's a small fraction of the page, which is why this design is fast.

It also makes a cheap guess at **what kind of page this is** (login / form /
checkout / table / article…) from DOM signals. Step 4 replaces that guess with
a real on-device image classifier; nothing around it has to change.

**The overlay — "show me what you see".** A new **Screen graph** tab in the
popup with a *Scan page* button. Press it and the page gets a labelled box
drawn around every element the agent perceives, tagged with the exact id the
server will use (`e3 textbox Full name`). Dashed pink boxes mark the regions it
*can't* read. A small panel in the corner reports the page kind, the counts,
and how long the scan took. The popup also lists every element in a filterable
table.

This is the demo artefact for the accuracy claim. Rather than saying "the agent
understands the page", you show it.

**The executor got real.** It now handles dropdowns (matching by value, then
visible text, then fuzzy), scrolling, and `ask_user`. Typing still goes through
the browser's native value setter, which is what makes React and Vue forms
actually register the change instead of silently reverting.

**The test page grew** a dropdown, a phone field, a link, prose, an image, and
an ID card drawn on a `<canvas>` — the canvas text exists only as pixels, so
it's genuinely invisible to the DOM. That's the gap Step 4 fills.

### Verified

Ran the real extractor against the demo page in a headless browser:

- **12 elements** found, every label resolved correctly from its `<label>` tag
- **0 redundant** duplicate labels; both opaque regions (canvas + image) caught
- Page correctly classified as `form` at 75% confidence
- Extraction took **2.8 ms** (budget was 10 ms)

Then ran the complete loop — extract → ask server → act — for real:

```
step 0: fill   e3  -> filled "Your name"
step 1: fill   e4  -> filled "you@example.com"
step 2: fill   e5  -> filled "10-digit mobile"
step 3: fill   e7  -> filled "Why do you need this?"
step 4: select e5  -> selected "Cartosat-3"
step 5: click  e8  -> clicked "Submit request"
step 6: done
```

Final state: every field filled, dropdown set, form submitted. Nobody touched
the keyboard.

### Not built yet (on purpose)

No screenshots, no PII detection, no redaction, no token vault, no real AI, no
on-device models. That's Steps 2–4.

---
