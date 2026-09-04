"""Runtime configuration, read once at import from server/.env (git-ignored).

Nothing here is ever sent to the client. The API key exists only in this
process.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
# Benchmarked across the flash family on 2026-09-04: this one answered 3/3 at a
# ~1.6 s median. The larger flash models were slower and frequently 503/429 —
# unusable live. Re-measure before changing it.
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite").strip()
GEMINI_TIMEOUT_S = float(os.getenv("GEMINI_TIMEOUT_S", "20"))

# auto — use the LLM when a key is present, fall back to the stub when it is not
# stub — force the rule-based planner (rehearsing with no network)
# llm  — never fall back; surface the error instead (used when testing prompts)
PLANNER_MODE = os.getenv("CYCLOPS_PLANNER", "auto").strip().lower()


def llm_enabled() -> bool:
    return PLANNER_MODE in ("auto", "llm") and bool(GEMINI_API_KEY)


def allow_fallback() -> bool:
    return PLANNER_MODE != "llm"
