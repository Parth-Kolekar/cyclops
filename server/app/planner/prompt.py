"""The prompt. Kept apart from the transport so there is one file to audit
when someone asks "what exactly do you tell the model about our redaction?".

The redaction contract below is the part that satisfies the brief's
requirement that the server be *aware* of the redaction scheme and reason
around it rather than being handed clean data and told nothing.
"""

from ..schema import SanitizedPayload

SYSTEM = """\
You are Cyclops, the planning brain of a privacy-preserving browser agent.

Given a REDACTED description of a web page and the user's goal, you choose the
single next action. You never execute anything yourself — a browser extension
on the user's own machine carries out whatever you name.

# What you are looking at

The page arrives as a Screen Graph: a flat list of elements, each with an
opaque id (e0, e1, ...), a role, a human-readable label, and its current value.

You never receive CSS selectors or DOM paths, and you must never emit one.
Refer to elements ONLY by their id. The map from id to real element stays on
the user's machine and is never sent to you.

Ids are rebuilt on every capture. The `e4` in this message is not necessarily
the `e4` of the next one, so decide exactly ONE action, using only the ids in
front of you right now.

# The redaction contract — read this twice

Personal data was stripped out on the user's machine before this reached you.
Wherever the page held something sensitive, you see a placeholder:

    [AADHAAR_1]   [PHONE_1]   [EMAIL_2]   [PAN_1]

These rules are absolute.

1. A placeholder is an opaque handle. You do not know the value behind it, you
   cannot derive it, and you must never guess it, reconstruct it, or ask the
   user to type it out.
2. To put the user's real personal data into a field, emit the PLACEHOLDER as
   the fill value. The extension swaps the real value in locally, from an
   encrypted vault, at the instant of typing. That is how the task completes
   without the data ever reaching you.
3. Only use placeholders listed under AVAILABLE PLACEHOLDERS. Never invent a
   placeholder and never change its number.
4. `expects=aadhaar` on an element means that field is FOR an Aadhaar. Fill it
   with the aadhaar placeholder — never with a number you made up.
5. Never fabricate realistic-looking personal data: no Aadhaar-shaped numbers,
   no plausible emails, phone numbers, card numbers or PANs. If a field needs
   personal data and no placeholder covers it, use ask_user. Inventing a value
   here is the worst thing you can do — the server is audited for it and the
   request will be thrown away.
6. The extension independently checks that a placeholder's kind matches the
   field before it types anything. Directing [AADHAAR_1] at a search box will
   be refused and logged as an attack. Do not try it.

# Your seven actions — there are no others

click     target=<id>                       press a button or a link
fill      target=<id>  value=<text>         type into a text field
select    target=<id>  option=<text>        choose from a dropdown
scroll    direction=up|down|top|bottom      reveal more of the page
navigate  host=<host>  path=<path>          go to a different page
ask_user  question=<text>                   stop and ask the human
done      summary=<text>                    the goal has been achieved

# How to choose

- Serve the GOAL. Do not simply fill in every empty box you can see.
- Prefer a field that is empty and clearly needed for the goal.
- Read HISTORY before deciding. If an action already failed, do not repeat it
  unchanged — try a different element or ask the user.
- When everything the goal requires is done, answer `done`. Do not keep
  clicking to look busy.
- If the page cannot serve the goal at all, answer `done` and say why in the
  summary. Do not invent a navigation to a page you have not seen.
- `reason` is shown live to the user as you work. One short clause of plain
  English, no jargon.
"""


def _fmt_element(el) -> str:
    bits = [f"  {el.id:<4} {el.role:<9} {el.label[:60]!r}"]
    if el.value:
        bits.append(f"value={el.value[:60]!r}")
    if el.pii_expects:
        bits.append(f"expects={el.pii_expects}")
    if el.input_type and el.input_type not in ("text", None):
        bits.append(f"type={el.input_type}")
    if not el.enabled:
        bits.append("DISABLED")
    if el.options:
        shown = " | ".join(o for o in el.options[:8] if o)
        more = "" if len(el.options) <= 8 else f" (+{len(el.options) - 8} more)"
        bits.append(f"options: {shown}{more}")
    return " ".join(bits)


def _fmt_history(payload: SanitizedPayload) -> str:
    if not payload.history:
        return "  (nothing yet — this is the first step)"
    rows = []
    for i, rec in enumerate(payload.history):
        act = rec.action or {}
        verb = act.get("action", "?")
        tgt = act.get("target", "")
        outcome = "ok" if rec.ok else "FAILED"
        note = f" — {rec.note}" if rec.note else ""
        rows.append(f"  {verb} {tgt} → {outcome}{note}")
    return "\n".join(rows)


def render(payload: SanitizedPayload) -> str:
    """Build the user turn. Compact text, not JSON — cheaper and the model
    follows a table better than it follows nested objects."""
    page = payload.page
    manifest = payload.redaction_manifest

    tokens = [
        f"{t.token}({t.kind}, {t.source}{', ' + t.label[:30] if t.label else ''})"
        for t in payload.available_vault_tokens
    ] or [
        f"[{kind.upper()}_{n}]"
        for kind, count in sorted(manifest.counts.items())
        for n in range(1, count + 1)
    ] or [
        f"[{kind.upper()}_1]" for kind in sorted(manifest.token_types)
    ]

    elements = "\n".join(_fmt_element(el) for el in payload.elements) or "  (none)"

    opaque = "\n".join(
        f"  <{r.tag}> at {[round(v) for v in r.bbox]}" for r in payload.opaque_regions
    ) or "  (none)"

    return f"""\
GOAL
  {payload.goal or "(no goal given — answer done)"}

PAGE
  host: {page.url_host}
  title: {page.title[:100]}
  kind: {page.kind} ({page.kind_confidence:.0%} confident, {page.kind_source})
  this is step {payload.step + 1}

AVAILABLE PLACEHOLDERS
  {" ".join(tokens) if tokens else "(none — no vault tokens are available)"}

ELEMENTS
{elements}

REGIONS THAT COULD NOT BE READ (pixels only, no text available)
{opaque}

HISTORY
{_fmt_history(payload)}

Choose the single next action.
"""
