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
- `src/content/index.js` — the part that lives inside the webpage. It does two
  things: **look** (walk the page and list every button, text box, link, with a
  made-up id like `e0`, `e1`) and **act** (click or type into whichever id the
  server names). Typing goes through the browser's native value setter so that
  React/Vue forms actually notice the change.
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

**The test page** (`demo/test-page.html`) — a simple form with name, email,
purpose, and a submit button, so we can watch the agent drive it.

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

### Not built yet (on purpose)

No screenshots, no PII detection, no redaction, no token vault, no real AI, no
on-device models. All of that is Steps 1–4.

---
