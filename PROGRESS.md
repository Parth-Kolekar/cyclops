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
cp .env.example .env              # then paste your API keys into it.
                                  # No keys? It still runs, on the old rules.
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

---

## Step 2 — The privacy filter ✅

**Goal:** stop personal data leaving the machine, while still letting the task
get done. This step covers two rubric lines worth 40% between them — how well
we *find* personal data, and how precisely we *destroy* it.

### The idea the whole project rests on

Most tools would delete the Aadhaar number and send a blank. Then the server
can't fill the form, and the task fails.

Instead we **swap it for a nametag**. The screen says `4321 8765 2109`; the
server receives `[AADHAAR_1]`. The real number stays on your laptop in a
"vault". The server can say *"put `[AADHAAR_1]` in the Aadhaar box"* — it can
reason about the field perfectly well without ever knowing the number. Cyclops
swaps the real value back in locally, at the last moment, and the form gets
filled correctly.

**The task completes with real data, and the server provably never had it.**

### Finding the personal data

Three kinds of detector:

1. **Pattern + real checksum.** A regex alone is not good enough — plenty of
   order numbers look like an Aadhaar. So every match is *verified*: Aadhaar
   against the Verhoeff checksum it actually uses, card numbers against Luhn,
   GSTIN against its base-36 check digit, PAN against the letter that encodes
   holder type, IFSC against its mandatory zero. This is the single biggest
   reason our false-positive count is zero.
2. **What the field is for.** A password box is personal data whatever it
   contains. A box labelled "Aadhaar number" is an Aadhaar box even when empty.
   Read from `input` types, `autocomplete` attributes, and a keyword list.
3. **The neighbourhood.** `14/03/1991` is just a date. `14/03/1991` in a row
   labelled "Date of birth" is personal data. We read the surrounding text to
   decide.

**The confidence rule, stated plainly:** checksum passes → certain (0.98).
Pattern matches and a nearby label backs it up → probable (0.75). Pattern
matches with nothing supporting it → **ignored**. That last line is what stops
us blacking out order references, and it is why the precision number holds up.

We deliberately lean towards over-detecting. A privacy tool that leaks 5% of
personal data is worthless; one that hides 5% too much is mildly annoying.

### Destroying it precisely

For text inside a paragraph we measure the exact pixels of the matched
characters and black out only those — not the whole sentence. Boxes are grown
by 4px, because covering slightly too much costs almost nothing while covering
slightly too little is a privacy failure.

Text is **filled in solid black, never blurred**. A blur is mathematically
reversible; deleting the pixels is not. A judge will ask this.

### The vault

Real values live in browser session memory — never written to disk, never
synced, gone when the browser closes, and unreachable from the webpage itself.
Only the extension's background worker can touch it.

**The rule that matters:** a nametag only goes back into a box of the matching
kind. If a hostile server says *"type `[AADHAAR_1]` into the search box"*,
Cyclops refuses and logs why. This is the answer to *"what if your server is
malicious?"* — and it's a live demo, not a claim.

### Proving it

- **Privacy tab** in the popup, with a **Show what leaves** button. It blacks
  out every identifier on the page and shows a side-by-side list: the real
  value on the left in red, the nametag that replaced it on the right in green.
  Under that, the vault (values masked), and the complete raw payload.
  The sentence to say on stage: *"this is every byte that left the machine."*
- **Two independent checks.** Before sending, the extension re-reads its own
  finished payload and refuses to send if any known-sensitive value survived.
  Then the server *independently* re-scans everything it receives, using a
  separately written detector, and rejects the request outright on any hit.
  That produces the counter for the results slide:
  **payloads processed: N · personal data seen by server: 0.**

### The demo page

`demo/portal.html` — a mock ISRO/Bhuvan data-request portal. A profile with a
real-format Aadhaar, PAN, mobile, email, date of birth, IFSC and GSTIN, and a
request form to be filled from it.

It also contains **deliberate traps**:

- an order reference `4321 8765 2100` — identical to the Aadhaar but for one
  digit, and it fails the checksum. A regex-only detector redacts it; ours
  doesn't.
- a 13-digit consignment number, a product code shaped like a PAN, and a scene
  ID shaped like a card number.
- a **search box**, which is not a personal-data field — the trap for the
  malicious-server demo.

### Measured

Ran the real detectors against the portal in a headless browser:

| | |
|---|---|
| Personal data found | **7 / 7** — recall **1.00** |
| Decoys wrongly flagged | **0 / 4** — precision **1.00** |
| Detection time | **5.5 ms** |
| Values surviving into the payload | **0** |
| Server guard on a clean payload | accepted |
| Server guard on a tampered payload | **rejected, HTTP 422** |

And the vault's kind rule:

```
ALLOW   aadhaar -> Aadhaar field
REFUSE  aadhaar -> search box      "Search the catalogue" is not an aadhaar field
REFUSE  aadhaar -> Mobile field    field expects phone, token is aadhaar
ALLOW   phone   -> Mobile field
```

### Two bugs the testing caught

Worth recording because both would have been embarrassing live:

1. Every value was being detected **twice** — a row like
   `<div><span>Aadhaar</span><span>4321…</span></div>` was counted as three
   overlapping pieces of text. Now only the innermost is kept.
2. The date of birth **leaked**. It was recognised in the full row but not in
   the bare `<span>` holding just the digits, so one copy went unredacted.
   Fixed by reading the surrounding text when deciding what a value is.

### Not built yet (on purpose)

No screenshots and no pixel redaction yet — that arrives in Step 4 alongside
the on-device models, since both need the same background infrastructure. No
real AI planner yet (Step 3). Names and addresses need a language model to
spot reliably, so they're Step 4 too.

---

## Step 3 — A real brain ✅

**Goal:** replace the three hard-coded rules with an actual language model, and
prove it can do the job while only ever seeing nametags instead of personal
data.

### What changed

Until now the "planner" was three rules in a fixed order: fill the first empty
box, then click the first button, then stop. It had no idea what the user
wanted. Now the server asks a real language model what to do next.

The difference is easiest to see side by side, on the same page and the same
goal — *"request Cartosat-3 imagery of Pune district for academic research"*:

| | Old rules | The model |
|---|---|---|
| First move | typed junk into the **search box** | skipped it — not part of the goal |
| Satellite dropdown | picked whichever option came first | picked **Cartosat-3**, because the goal said so |
| Purpose field | typed "academic research" from a lookup table | typed "Academic research on Pune district" |
| Finishing | stopped after one click | submitted, then confirmed what it had done |

Both fill the Aadhaar box with `[AADHAAR_1]` — that part was already right. The
new part is that the agent now understands *why* it is filling anything.

### The contract we hand the model

There is one file that contains everything the model is ever told
(`server/app/planner/prompt.py`), so the question *"what exactly does your
server know about the redaction?"* has a single, readable answer. It spells out:

- it will never see a CSS selector, only opaque ids like `e3`
- ids are rebuilt on every look at the page, so it must decide **one** action at
  a time and never plan ahead on stale ids
- `[AADHAAR_1]` is a nametag, not a value. It cannot be guessed or unpacked, and
  the way to fill a personal field is to name the nametag and let the extension
  swap the real value in locally
- it must never invent realistic-looking personal data. If a field needs
  something no nametag covers, it must stop and ask the user
- the extension independently checks the nametag matches the field before
  typing, so misdirecting one is pointless

### Treating the model as untrusted

An LLM is a stranger on the internet, so nothing it says is acted on until it
has been checked. Every reply must survive all of this:

| Check | Why |
|---|---|
| The verb is one of the seven | An eighth verb is a bug or an attack |
| The target id exists **in this capture** | Stops it inventing an element that isn't there |
| Any nametag it uses was actually offered | Stops it reaching for data the page never had |
| The typed text contains no real-looking personal data | Stops it fabricating an Aadhaar instead of using the nametag |

Tested against ten deliberately bad replies: all seven bad ones refused, both
good ones accepted, and ordinary text like "Pune district imagery" still passes
— the checks aren't just blocking everything.

If a reply fails, the model is told exactly what was wrong and given another
go. Only if that also fails do we fall back to the old rules.

### It never dies on stage

There is no single brain to lose. The server works down a chain until something
answers:

**DeepSeek** (via OpenRouter) → **Gemini** → **the old rules**

Each provider gets two tries — one, then a repair attempt where it is told
exactly what was wrong with its answer. If it is still failing, moving to a
different provider is a better use of the next two seconds than a third go at
the one that is struggling. The popup prints which brain answered, so if it ever
quietly drops down the chain mid-demo you can see it happen instead of wondering
why the agent got stupid.

There is also a switch (`CYCLOPS_PLANNER=stub`) that forces the old rules and
needs no internet at all, for rehearsing on a venue's wifi.

### Why there is a chain at all — worth knowing

We benchmarked eight Gemini models on the real prompt before picking one, and
the result was worse than expected:

| Model | Worked | Speed |
|---|---|---|
| `gemini-3.5-flash-lite` | **3 of 3** | **1.6 s** |
| `gemini-3.1-flash-lite` | 3 of 3 | 2.5 s |
| `gemini-3.7-flash` | 1 of 3 | 8.8 s |
| `gemini-3.8-flash`, `3.6`, `3.5` | 0 of 3 | — |

The bigger models were constantly busy — "this model is currently experiencing
high demand" — and slow when they did answer. One trivial request took 25
seconds and four in five failed outright. On stage that is three minutes of
silence.

Even the model that won is on a service that visibly buckles under load, which
is not something to stake a live demo on. So Gemini became the understudy and
**DeepSeek V4 Flash** took the lead: it is a tenth of the price, has a far
larger context window, and is not fighting the same traffic. Two independent
providers, either of which can carry the demo alone.

**Do not swap either model without re-running the benchmark.** That table is
the whole reason the architecture looks like this.

### Measured

A full eight-step run against Gemini, start to submitted form:

| | |
|---|---|
| Steps planned by the model | **8 of 8** |
| Falls back to the old rules | **0** |
| Median thinking time | **1.6 s** per step |
| Personal data sent to the provider | **none** — nametags only |

The same run against DeepSeek is **not measured yet** — the key had not been
added when this was written. The safety checks below are provider-independent
and were verified.

### One known gap

Asked to fill a "Full name" box, the model makes a name up ("Academic
Researcher"). It is inventing a fake name rather than leaking a real one, so
nothing escapes — but a made-up name on a government form is still wrong. Names
can't be detected reliably without a language model reading the page, which is
exactly what Step 4 adds; once there is a `[NAME_1]` nametag to reach for, the
model will use it like it already uses the others.

### Setting it up

Put an OpenRouter key and a Gemini key in `server/.env` (the file is
git-ignored, and `server/.env.example` shows the shape). Either one alone is
enough — the chain just skips whichever provider has no key. With neither,
everything still runs on the old rules.

---
