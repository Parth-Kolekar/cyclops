"""The real planner — OpenRouter first, Gemini as the understudy.

No vendor SDKs. `httpx` was already a dependency, both APIs are a handful of
keys of JSON, and an SDK that changes shape the week before a demo is risk with
no upside. Same reasoning as the extension having no bundler.

Providers are tried in the order given by CYCLOPS_PROVIDERS. OpenRouter leads
because Gemini's flash fleet returns 503 "experiencing high demand" often enough
to lose a demo on its own — measured, not assumed. If every provider fails,
`main.py` drops to the Phase 0 rule stub rather than letting the demo die.

Everything a model returns is treated as hostile until checked:

  * the verb must be one of the seven
  * the target must be an id that exists in THIS capture (no hallucinated ids)
  * a placeholder may only be used if the manifest actually offered that kind
  * a fill value must not contain fabricated personal data
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

GEMINI_ROOT = "https://generativelanguage.googleapis.com/v1beta/models"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

PLACEHOLDER_RE = re.compile(r"\[([A-Z][A-Z0-9]*)_(\d+)\]")

# Attempts per provider. Kept low because a second provider is a better use of
# the next two seconds than a third try at the one that is struggling.
MAX_ATTEMPTS = 2

# Transient on the provider's side — worth another go. A bad key or a wrong
# model name is not, and retrying it just burns demo time.
RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504}


class PlannerError(RuntimeError):
    """A model failed, timed out, or returned something we refuse to act on."""

    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


def _terse(text: str) -> str:
    """Provider error bodies are several lines of JSON. Keep the sentence."""
    try:
        body = json.loads(text)
        err = body.get("error")
        if isinstance(err, dict):
            return str(err.get("message", err))[:200]
        return str(err or body)[:200]
    except Exception:
        return text[:200]


# ------------------------------------------------------------------ schema

_PROPERTIES = {
    "action": {
        "type": "string",
        "enum": ["click", "fill", "select", "scroll", "navigate", "ask_user", "done"],
    },
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
}

_ALL_FIELDS = list(_PROPERTIES)

# JSON Schema cannot express "option is required *when* action is select", and
# Gemini treats `required` as the real constraint while descriptions are close
# to decorative — four different Gemini models all emitted `select` with no
# `option`. So every field a verb might need is required outright; the verbs
# that do not need one get "" back and _to_action ignores it.
GEMINI_SCHEMA = {
    "type": "object",
    "properties": _PROPERTIES,
    "required": ["action", "target", "value", "option", "reason", "confidence"],
    # Decide the verb first, so the dependent fields are filled with the verb
    # already committed to.
    "propertyOrdering": _ALL_FIELDS,
}

# OpenAI-style strict mode, which OpenRouter forwards, demands that every
# property be required and that no extras are allowed.
OPENROUTER_SCHEMA = {
    "type": "object",
    "properties": _PROPERTIES,
    "required": _ALL_FIELDS,
    "additionalProperties": False,
}

# Used only when a model cannot do schema-enforced output and we fall back to
# plain JSON mode, where the shape has to live in the prompt instead.
SHAPE_HINT = (
    "\nReply with a single JSON object and nothing else, using exactly these keys:\n"
    '{"action": one of click|fill|select|scroll|navigate|ask_user|done,\n'
    ' "target": element id such as "e3" (click, fill, select),\n'
    ' "value": text to type (fill),\n'
    ' "option": exact option text (select),\n'
    ' "direction": up|down|top|bottom (scroll),\n'
    ' "host": string, "path": string (navigate),\n'
    ' "question": string (ask_user), "summary": string (done),\n'
    ' "reason": one short clause, "confidence": number between 0 and 1}\n'
    "Use \"\" for keys that do not apply to the verb you chose.\n"
)

# Set once, the first time a model rejects schema-enforced output, so we do not
# pay for the same 400 on every subsequent step.
_openrouter_json_mode = "schema"


# --------------------------------------------------------------- providers


async def _post(url: str, headers: dict, body: dict) -> httpx.Response:
    try:
        async with httpx.AsyncClient(timeout=config.LLM_TIMEOUT_S) as client:
            return await client.post(url, headers=headers, json=body)
    except httpx.HTTPError as err:
        # str() on a timeout is usually empty, which makes the log say nothing
        # at the one moment you need it to speak.
        raise PlannerError(f"{type(err).__name__}: {err or 'no detail'}", retryable=True)


async def _call_gemini(system: str, user: str, model: str, image_base64: str | None = None) -> dict:
    body = {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}] + ([{"inlineData": {"mimeType": "image/jpeg", "data": image_base64.split(",")[1] if "," in image_base64 else image_base64}}] if image_base64 else [])}],
        "generationConfig": {
            "temperature": 0.1,
            "responseMimeType": "application/json",
            "responseSchema": GEMINI_SCHEMA,
        },
    }
    resp = await _post(
        f"{GEMINI_ROOT}/{model}:generateContent",
        {"x-goog-api-key": config.GEMINI_API_KEY},
        body,
    )
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
    return _parse_json(text)


async def _call_openrouter(system: str, user: str, model: str, image_base64: str | None = None) -> dict:
    global _openrouter_json_mode

    def build(mode: str) -> dict:
        sys_text = system if mode == "schema" else system + SHAPE_HINT
        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": sys_text},
                {"role": "user", "content": user if not image_base64 else [
                    {"type": "text", "text": user},
                    {"type": "image_url", "image_url": {"url": image_base64}}
                ]},
            ],
            "temperature": 0.1,
        }
        if mode == "schema":
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "cyclops_action",
                    "strict": True,
                    "schema": OPENROUTER_SCHEMA,
                },
            }
        else:
            body["response_format"] = {"type": "json_object"}
        return body

    headers = {
        "Authorization": f"Bearer {config.OPENROUTER_API_KEY}",
        # OpenRouter attributes traffic with these; harmless and it keeps the
        # dashboard readable.
        "HTTP-Referer": "https://github.com/cyclops-sih",
        "X-Title": "Cyclops",
    }

    resp = await _post(OPENROUTER_URL, headers, build(_openrouter_json_mode))

    # Not every model can do schema-enforced output. Drop to plain JSON mode
    # once and remember, rather than paying for the same 400 on every step.
    if resp.status_code == 400 and _openrouter_json_mode == "schema":
        print(f"[llm] {model} rejected json_schema — using json_object from here on")
        _openrouter_json_mode = "object"
        resp = await _post(OPENROUTER_URL, headers, build("object"))

    if resp.status_code != 200:
        raise PlannerError(
            f"openrouter {resp.status_code}: {_terse(resp.text)}",
            retryable=resp.status_code in RETRYABLE_STATUS,
        )

    data = resp.json()
    # OpenRouter can answer 200 with an error body when an upstream fails.
    if "error" in data and not data.get("choices"):
        raise PlannerError(f"openrouter upstream: {_terse(resp.text)}", retryable=True)
    try:
        text = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError):
        raise PlannerError(f"openrouter returned no usable choice: {_terse(resp.text)}")
    return _parse_json(text)


def _parse_json(text: str) -> dict:
    text = (text or "").strip()
    # Some models wrap JSON in a ```json fence despite being asked not to.
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as err:
        raise PlannerError(f"model returned non-JSON: {err}")
    if not isinstance(raw, dict):
        raise PlannerError(f"model returned {type(raw).__name__}, expected an object")
    return raw


PROVIDERS = {"openrouter": _call_openrouter, "gemini": _call_gemini}


# -------------------------------------------------------------- validation


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
        if not value:
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


# -------------------------------------------------------------------- plan


async def _try_provider(name: str, model: str, payload: SanitizedPayload) -> Plan:
    call = PROVIDERS[name]
    base = prompt.render(payload)
    user = base
    last: PlannerError | None = None

    for attempt in range(MAX_ATTEMPTS):
        try:
            raw = await call(prompt.SYSTEM, user, model, payload.image_base64)
        except PlannerError as err:
            last = err
            if not err.retryable:
                raise
            print(f"[llm] {name} attempt {attempt + 1}/{MAX_ATTEMPTS}: {err} — retrying")
            await asyncio.sleep(0.5 * (attempt + 1))
            continue

        try:
            action = _to_action(raw, payload)
        except PlannerError as err:
            last = err
            # Tell it exactly what was wrong and let it correct itself.
            print(f"[llm] {name} attempt {attempt + 1}/{MAX_ATTEMPTS} rejected: {err}")
            user = (
                f"{base}\n"
                f"Your previous answer was rejected: {err}\n"
                f"Answer again, correctly."
            )
            continue

        confidence = raw.get("confidence")
        return Plan(
            steps=[action],
            confidence=float(confidence) if isinstance(confidence, (int, float)) else 0.8,
            planner=f"{name}:{model}",
        )

    raise PlannerError(f"{name} gave up after {MAX_ATTEMPTS} attempts — {last}")


async def plan(payload: SanitizedPayload) -> Plan:
    """One action, validated, from the first provider that can supply one.

    Deliberately one action at a time: element ids are only stable within a
    single capture, so a multi-step plan would be built on ids that no longer
    mean anything by step two.
    """
    providers = config.active_providers()
    if not providers:
        raise PlannerError("no provider has an API key")

    last: Exception | None = None
    for name in providers:
        try:
            return await _try_provider(name, config.MODELS[name], payload)
        except Exception as err:
            last = err
            print(f"[llm] {name} unusable — {type(err).__name__}: {err or 'no detail'}")

    raise PlannerError(f"all providers failed ({', '.join(providers)}) — {last}")
