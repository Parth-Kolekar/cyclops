"""Independent PII re-scan of every inbound payload.

Deliberately a *separate implementation* from the client's detectors, not a
shared library. The point is defence in depth: if the client's sanitiser has a
bug, a copy of that same bug would not catch it. This one is written from the
spec, not from the other code.

It also produces the number that goes on the results slide:

    payloads processed: N, PII detected server-side: 0

which is more persuasive than any architecture diagram.
"""

import re

# --------------------------------------------------------------- checksums

_VERHOEFF_D = [
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
]
_VERHOEFF_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]


def verhoeff(digits: str) -> bool:
    """The checksum Aadhaar uses. Rejects almost every look-alike."""
    c = 0
    for i, ch in enumerate(reversed(digits)):
        c = _VERHOEFF_D[c][_VERHOEFF_P[i % 8][int(ch)]]
    return c == 0


def luhn(digits: str) -> bool:
    total, alt = 0, False
    for ch in reversed(digits):
        d = int(ch)
        if alt:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        alt = not alt
    return len(digits) >= 13 and total % 10 == 0


_GST_ALPHA = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def gstin_valid(code: str) -> bool:
    if len(code) != 15:
        return False
    total = 0
    for i, ch in enumerate(code[:14]):
        if ch not in _GST_ALPHA:
            return False
        p = _GST_ALPHA.index(ch) * (2 if i % 2 else 1)
        total += p // 36 + p % 36
    return _GST_ALPHA[(36 - total % 36) % 36] == code[14]


# ----------------------------------------------------------------- rules

_PAN_HOLDER = set("PCHFATBLJG")


def _aadhaar_ok(m: str) -> bool:
    return verhoeff(re.sub(r"\D", "", m))


def _card_ok(m: str) -> bool:
    return luhn(re.sub(r"\D", "", m))


RULES: list[tuple[str, re.Pattern, callable] ] = [
    ("aadhaar", re.compile(r"\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b"), _aadhaar_ok),
    ("card", re.compile(r"\b(?:\d[ -]?){13,19}\b"), _card_ok),
    ("gstin", re.compile(r"\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b"), gstin_valid),
    ("pan", re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b"), lambda m: m[3] in _PAN_HOLDER),
    ("ifsc", re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b"), lambda m: m[4] == "0"),
    ("email", re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b"), lambda m: True),
    ("phone", re.compile(r"(?:\+?91[-\s]?)?\b[6-9]\d{9}\b"), lambda m: True),
]

# Our own placeholders must not be mistaken for the thing they replace.
TOKEN_RE = re.compile(r"\[[A-Z_]+_\d+\]")


def scan_text(text: str) -> list[dict]:
    """Return every PII hit in one string. Empty list means clean."""
    if not text:
        return []
    # Blank out placeholders first so "[EMAIL_1]" cannot itself trip a rule.
    text = TOKEN_RE.sub(" ", text)

    hits = []
    for kind, pattern, validate in RULES:
        for m in pattern.finditer(text):
            raw = m.group(0).strip()
            if validate(raw):
                hits.append({"kind": kind, "at": m.start(), "sample": _redact(raw)})
    return hits


def _redact(value: str) -> str:
    """Never log the thing we are complaining about receiving."""
    return f"{value[:2]}…{value[-2:]} ({len(value)} chars)"


def _walk(node, out: list[str]) -> None:
    """Collect every string anywhere in the payload, at any depth."""
    if isinstance(node, str):
        out.append(node)
    elif isinstance(node, dict):
        for v in node.values():
            _walk(v, out)
    elif isinstance(node, (list, tuple)):
        for v in node:
            _walk(v, out)


def scan(payload) -> list[dict]:
    """Re-scan a whole inbound payload. Returns the kinds that got through."""
    strings: list[str] = []
    raw = payload.model_dump() if hasattr(payload, "model_dump") else payload
    _walk(raw, strings)

    hits: list[dict] = []
    for s in strings:
        hits.extend(scan_text(s))
    return hits
