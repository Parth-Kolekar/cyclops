"""Runtime configuration, read once at import from server/.env (git-ignored).

Nothing here is ever sent to the client. API keys exist only in this process.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

# ------------------------------------------------------------- providers

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "").strip()
OPENROUTER_MODEL = os.getenv(
    "OPENROUTER_MODEL", "deepseek/deepseek-v4-flash-0731"
).strip()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite").strip()

LLM_TIMEOUT_S = float(os.getenv("LLM_TIMEOUT_S", os.getenv("GEMINI_TIMEOUT_S", "20")))
LLM_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "4000"))

# Tried left to right; the first one holding a key answers, the rest are the
# safety net. Gemini sits second because its flash fleet returns 503 under load
# often enough to lose a demo on its own.
PROVIDER_ORDER = [
    p.strip().lower()
    for p in os.getenv("CYCLOPS_PROVIDERS", "openrouter,gemini").split(",")
    if p.strip()
]

# ---------------------------------------------------------------- planner

# auto — use the LLM providers that have keys, fall back to the stub
# stub — force the rule-based planner (rehearsing with no network)
# llm  — never fall back to the stub; surface the error instead
PLANNER_MODE = os.getenv("CYCLOPS_PLANNER", "auto").strip().lower()
STRICT_GUARD = os.getenv("CYCLOPS_STRICT_GUARD", "false").strip().lower() in ("true", "1", "yes")

KEYS = {"openrouter": OPENROUTER_API_KEY, "gemini": GEMINI_API_KEY}
MODELS = {"openrouter": OPENROUTER_MODEL, "gemini": GEMINI_MODEL}


def active_providers() -> list[str]:
    """Configured providers that actually have a key, in preference order."""
    return [p for p in PROVIDER_ORDER if KEYS.get(p)]


def llm_enabled() -> bool:
    return PLANNER_MODE in ("auto", "llm") and bool(active_providers())


def allow_fallback() -> bool:
    return PLANNER_MODE != "llm"


def describe() -> str:
    chain = [f"{p}:{MODELS[p]}" for p in active_providers()]
    return " -> ".join(chain + ["stub"]) if chain else "stub"
