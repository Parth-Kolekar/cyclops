"""Phase 0 planner — no AI, just rules.

Its only job is to prove the pipe works end to end: the extension can send a
description of a page, get a real action back, and perform it. Phase 3 swaps
this out for an LLM behind the same `plan()` signature.

The rules, in order:
  1. Fill the first empty text field with something derived from its label.
  2. Otherwise click the first enabled button.
  3. Otherwise declare the task done.
"""

from ..schema import Click, Done, Fill, Plan, SanitizedPayload, Select

TEXT_ROLES = {"textbox"}
SKIP_INPUT_TYPES = {"hidden", "file", "submit", "button", "reset", "checkbox", "radio"}

# Crude label -> sample value table so the filled form looks plausible on stage.
SAMPLES = [
    (("email", "e-mail"), "demo@cyclops.local"),
    (("phone", "mobile"), "9876543210"),
    (("name",), "Demo User"),
    (("aadhaar", "aadhar"), "4321 8765 2109"),
    (("pan",), "ABCPD1234K"),
    (("purpose", "reason"), "academic research"),
    (("area", "district", "region"), "Pune district"),
]


def _is_placeholder(option: str) -> bool:
    low = option.lower()
    return low.startswith(("choose", "select", "pick", "--")) or low in {"", "none"}


def _sample_for(label: str) -> str:
    low = label.lower()
    for keys, value in SAMPLES:
        if any(k in low for k in keys):
            return value
    return "Cyclops test value"


def plan(payload: SanitizedPayload) -> Plan:
    already_clicked = any(
        rec.action.get("action") == "click" for rec in payload.history
    )

    for el in payload.elements:
        if el.role not in TEXT_ROLES or not el.enabled:
            continue
        if el.input_type in SKIP_INPUT_TYPES:
            continue
        if (el.value or "").strip():
            continue  # already filled
        return Plan(
            steps=[
                Fill(
                    action="fill",
                    target=el.id,
                    value=_sample_for(el.label),
                    reason=f'field "{el.label}" is empty',
                )
            ],
            confidence=0.4,
        )

    for el in payload.elements:
        if el.role != "select" or not el.enabled or not el.options:
            continue
        if (el.value or "").strip():
            continue
        choice = next((o for o in el.options if o), None)
        # Skip the usual "Choose one…" placeholder row.
        if choice and len(el.options) > 1 and _is_placeholder(choice):
            choice = el.options[1]
        if choice:
            return Plan(
                steps=[
                    Select(
                        action="select",
                        target=el.id,
                        option=choice,
                        reason=f'dropdown "{el.label}" is unset',
                    )
                ],
                confidence=0.4,
            )

    if not already_clicked:
        for el in payload.elements:
            if el.role == "button" and el.enabled:
                return Plan(
                    steps=[
                        Click(
                            action="click",
                            target=el.id,
                            reason=f'submitting via "{el.label}"',
                        )
                    ],
                    confidence=0.4,
                )

    return Plan(
        steps=[Done(action="done", summary="stub planner has nothing left to do")],
        confidence=1.0,
    )
