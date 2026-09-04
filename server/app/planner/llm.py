"""The real planner — Google Gemini over plain REST.

No vendor SDK on purpose. `httpx` was already a dependency, the request shape
is four keys, and an SDK that changes its API the week before a demo is a risk
with no upside. Same reasoning as the extension having no bundler.

Everything the model returns is treated as hostile until checked:

  * the verb must be one of the seven
  * the target must be an id that exists in THIS capture (no hallucinated ids)
  * a placeholder may only be used if the manifest actually offered that kind
  * a fill value must not contain fabricated personal data

A failure raises PlannerError, and `main.py` falls back to the stub rather than
letting the demo die.
"""

import asyncio
import json
import re

import httpx

from .. import config
from ..guard import verifier
from ..schema import (
    AnyAction,
    AskUser,
    Click,
    Done,
    Fill,
    Navigate,
    Plan,
    SanitizedPayload,
    Scroll,
    Select,
)
from . import prompt

API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models"

PLACEHOLDER_RE = re.compile(r"\[([A-Z][A-Z0-9]*)_(\d+)\]")


MAX_ATTEMPTS = 3

# Transient on Google's side — worth another go. A bad key or a wrong model
# name is not, and retrying it just burns demo time.
RETRYABLE_STATUS = {429, 500, 502, 503, 504}


class PlannerError(RuntimeError):
    """The model failed, timed out, or returned something we refuse to act on."""

    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


def _terse(text: str) -> str:
    """Google's error bodies are six lines of JSON. Keep the sentence."""
    try:
        return json.loads(text)["error"]["message"]
    except Exception:
        return text[:200]


# Gemini's structured output handles a flat object far more reliably than a
# seven-way union, so we ask for one shape with optional fields and rebuild the
# real typed action ourselves. The wire contract stays frozen at seven verbs.
RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "action": {
            "type": "string",
            "enum": ["click", "fill", "select", "scroll", "navigate", "ask_user", "done"],
        },
        # Only three fields can be globally required, so which of the rest are
        # mandatory is spelled out here per verb. Without this, models happily
        # emit `select` with no option and burn a retry.
        "target": {
            "type": "string",
            "description": "element id such as e3. REQUIRED for click, fill and select.",
        },
        "value": {
            "type": "string",
            "description": "the text to type. REQUIRED when action is fill.",
        },
        "option": {
            "type": "string",
            "description": "exact option text to choose. REQUIRED when action is select.",
        },
        "direction": {"type": "string", "enum": ["up", "down", "top", "bottom"]},
        "host": {"type": "string"},
        "path": {"type": "string"},
        "question": {"type": "string"},
        "summary": {"type": "string"},
        "reason": {"type": "string", "description": "one short clause, shown to the user"},
        "confidence": {"type": "number"},
    },
    # JSON Schema cannot express "option is required *when* action is select",
    # and Gemini treats `required` as the real constraint while descriptions are
    # close to decorative — four different models all emitted `select` with no
    # `option`. So every field any verb might need is required outright. Verbs
    # that do not need one get "" back, and _to_action ignores it.
    "required": ["action", "target", "value", "option", "reason", "confidence"],
    # Decide the verb first; the fields that depend on it are then filled in
    # with the verb already committed to.
    "propertyOrdering": [
        "action", "target", "value", "option", "direction",
        "host", "path", "question", "summary", "reason", "confidence",
    ],
}


async def _call(system: str, user: str) -> dict:
    body = {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {
            "temperature": 0.1,
            "responseMimeType": "application/json",
            "responseSchema": RESPONSE_SCHEMA,
        },
    }
    url = f"{API_ROOT}/{config.GEMINI_MODEL}:generateContent"
    try:
        async with httpx.AsyncClient(timeout=config.GEMINI_TIMEOUT_S) as client:
            resp = await client.post(
                url,
                headers={"x-goog-api-key": config.GEMINI_API_KEY},
                json=body,
            )
    except httpx.HTTPError as err:
        # str() on a timeout is usually empty, which makes the log say nothing
        # at the one moment you need it to speak.
        raise PlannerError(f"{type(err).__name__}: {err or 'no detail'}", retryable=True)

    if resp.status_code != 200:
        raise PlannerError(
            f"gemini {resp.status_code}: {_terse(resp.text)}",
            retryable=resp.status_code in RETRYABLE_STATUS,
        )

    data = resp.json()
    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        reason = (data.get("candidates") or [{}])[0].get("finishReason", "?")
        raise PlannerError(f"gemini returned no usable candidate (finishReason={reason})")

    try:
        return json.loads(text)
    except json.JSONDecodeError as err:
        raise PlannerError(f"gemini returned non-JSON: {err}")


def _check_fill_value(value: str, token_types: set[str]) -> None:
    """A fill may carry placeholders, or ordinary text, but never invented PII."""
    for kind, _n in PLACEHOLDER_RE.findall(value):
        if kind.lower() not in token_types:
            raise PlannerError(
                f"used placeholder [{kind}_…] but the manifest only offers "
                f"{sorted(token_types) or 'nothing'}"
            )

    # Whatever is left after removing our own placeholders must be innocent.
    residue = PLACEHOLDER_RE.sub(" ", value)
    hits = verifier.scan_text(residue)
    if hits:
        kinds = sorted({h["kind"] for h in hits})
        raise PlannerError(
            f"fabricated personal data in the fill value ({', '.join(kinds)}) — "
            "use the placeholder instead"
        )


def _to_action(raw: dict, payload: SanitizedPayload) -> AnyAction:
    verb = (raw.get("action") or "").strip()
    reason = (raw.get("reason") or "").strip()
    ids = {el.id for el in payload.elements}
    token_types = set(payload.redaction_manifest.token_types)

    def target() -> str:
        t = (raw.get("target") or "").strip()
        if t not in ids:
            raise PlannerError(f"target {t!r} is not an element in this capture")
        return t

    if verb == "click":
        return Click(action="click", target=target(), reason=reason)

    if verb == "fill":
        t = target()
        value = raw.get("value")
        if value is None:
            raise PlannerError("fill without a value")
        _check_fill_value(value, token_types)
        return Fill(action="fill", target=t, value=value, reason=reason)

    if verb == "select":
        t = target()
        option = (raw.get("option") or "").strip()
        if not option:
            raise PlannerError("select without an option")
        return Select(action="select", target=t, option=option, reason=reason)

    if verb == "scroll":
        direction = (raw.get("direction") or "down").strip()
        if direction not in ("up", "down", "top", "bottom"):
            raise PlannerError(f"bad scroll direction {direction!r}")
        return Scroll(action="scroll", direction=direction, reason=reason)

    if verb == "navigate":
        host = (raw.get("host") or "").strip()
        path = (raw.get("path") or "/").strip()
        if not host:
            raise PlannerError("navigate without a host")
        return Navigate(action="navigate", host=host, path=path, reason=reason)

    if verb == "ask_user":
        question = (raw.get("question") or reason).strip()
        if not question:
            raise PlannerError("ask_user without a question")
        return AskUser(action="ask_user", question=question)

    if verb == "done":
        return Done(action="done", summary=(raw.get("summary") or reason).strip())

    raise PlannerError(f"{verb!r} is not one of the seven verbs")


async def plan(payload: SanitizedPayload) -> Plan:
    """One action from the model, validated. Raises PlannerError if unusable.

    Deliberately one action at a time: element ids are only stable within a
    single capture, so a multi-step plan would be built on ids that no longer
    mean anything by step two.
    """
    system = prompt.SYSTEM
    user = prompt.render(payload)

    last: PlannerError | None = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            raw = await _call(system, user)
        except PlannerError as err:
            last = err
            if not err.retryable:
                raise
            # "This model is currently experiencing high demand" shows up often
            # enough that surrendering to the stub on the first one would make
            # the agent look stupid on stage for no reason.
            print(f"[llm] attempt {attempt + 1}/{MAX_ATTEMPTS}: {err} — retrying")
            await asyncio.sleep(0.6 * (attempt + 1))
            continue

        try:
            action = _to_action(raw, payload)
        except PlannerError as err:
            last = err
            # Tell it exactly what was wrong and let it correct itself. Cheaper
            # than dropping to the stub mid-demo.
            print(f"[llm] attempt {attempt + 1}/{MAX_ATTEMPTS} rejected: {err}")
            user = (
                f"{prompt.render(payload)}\n"
                f"Your previous answer was rejected: {err}\n"
                f"Answer again, correctly."
            )
            continue

        confidence = raw.get("confidence")
        return Plan(
            steps=[action],
            confidence=float(confidence) if isinstance(confidence, (int, float)) else 0.8,
            planner=f"gemini:{config.GEMINI_MODEL}",
        )

    raise PlannerError(f"gave up after {MAX_ATTEMPTS} attempts — {last}")
