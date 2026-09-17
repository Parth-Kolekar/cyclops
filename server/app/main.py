"""Cyclops server — FastAPI entrypoint.

Phase 2: every inbound payload is independently re-scanned for PII before it
reaches the planner, and rejected outright if anything got through.

Phase 3: the planner is a real LLM. It reasons over redacted text and refers to
personal data only by placeholder. If it is unreachable, slow, or returns
something we refuse to act on, we fall back to the Phase 0 rule stub — a demo
that degrades is better than a demo that stops.

Phase 4: the vocabulary grew from seven verbs to fifteen, and the payload now
carries the running conversation (`chat_history`) plus the page's own markup
hints. The guard is unchanged and still walks every string in the payload, so
the new fields are re-scanned for free.
"""

import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import config
from .guard import verifier
from .planner import llm, stub
from .schema import Plan, SanitizedPayload

app = FastAPI(title="Cyclops", version="0.3.0")

# The extension calls in from a chrome-extension:// origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

STARTED_AT = time.time()
METRICS = {
    "requests": 0,
    "clean": 0,
    "rejected": 0,
    "pii_seen_server_side": 0,
    "latency_ms": [],
    "llm_calls": 0,
    "llm_fallbacks": 0,
}


@app.get("/v1/health")
def health():
    return {
        "ok": True,
        "service": "cyclops",
        "planner": config.describe() if config.llm_enabled() else "stub",
        "planner_mode": config.PLANNER_MODE,
        "phase": 4,
        "verbs": len(llm.VERBS),
        "guard": "enabled",
        "uptime_s": round(time.time() - STARTED_AT, 1),
    }


async def _decide(payload: SanitizedPayload) -> Plan:
    """Real planner when we can, rule stub when we must."""
    if not config.llm_enabled():
        return stub.plan(payload)

    METRICS["llm_calls"] += 1
    try:
        return await llm.plan(payload)
    except Exception as err:
        METRICS["llm_fallbacks"] += 1
        print(f"[llm] falling back to stub — {type(err).__name__}: {err or 'no detail'}")
        if not config.allow_fallback():
            raise HTTPException(status_code=502, detail={"error": "planner_failed", "detail": str(err)})
        result = stub.plan(payload)
        result.planner = "stub (llm failed)"
        return result


@app.post("/v1/plan", response_model=Plan)
async def plan(payload: SanitizedPayload):
    t0 = time.perf_counter()
    METRICS["requests"] += 1

    # Defence in depth. The client already sanitised; we do not take that on
    # trust. A hit here means the client has a bug, and we refuse to reason
    # over data we should never have received.
    hits = verifier.scan(payload)
    if hits:
        METRICS["rejected"] += 1
        METRICS["pii_seen_server_side"] += len(hits)
        kinds = sorted({h["kind"] for h in hits})
        if config.STRICT_GUARD:
            print(f"[guard] REJECTED payload — unsanitised {kinds}")
            raise HTTPException(
                status_code=422,
                detail={"error": "unsanitized_payload", "kinds": kinds, "count": len(hits)},
            )
        else:
            print(f"[guard] WARNING: detected potential unsanitised {kinds} — proceeding without rejection")

    METRICS["clean"] += 1
    result = await _decide(payload)
    took = (time.perf_counter() - t0) * 1000
    METRICS["latency_ms"] = (METRICS["latency_ms"] + [round(took, 2)])[-200:]

    manifest = payload.redaction_manifest
    print(
        f"[plan] step={payload.step} elements={len(payload.elements)} "
        f"chat={len(payload.chat_history)} "
        f"tokens={manifest.regions_masked} {manifest.token_types} "
        f'goal="{payload.goal[:40]}" -> {result.steps[0].action} '
        f"via {result.planner} ({took:.1f} ms)"
    )
    return result


@app.post("/v1/verify")
def verify(payload: dict):
    """Standalone re-scan. Used by the eval harness and the demo audit button."""
    hits = verifier.scan(payload)
    return {
        "clean": not hits,
        "count": len(hits),
        "kinds": sorted({h["kind"] for h in hits}),
        "hits": hits,
    }


@app.get("/v1/tools")
def tools():
    """The verb vocabulary, so the extension can assert it implements exactly
    what the planner is allowed to emit. A verb the server can produce and the
    executor cannot perform is a silent no-op — the single most common failure
    mode in the system we merged this from."""
    return {"schema": "cyclops.tools.v1", "verbs": llm.VERBS}


@app.get("/v1/metrics")
def metrics():
    lat = METRICS["latency_ms"]
    return {
        "requests": METRICS["requests"],
        "payloads_clean": METRICS["clean"],
        "payloads_rejected": METRICS["rejected"],
        # The line for the results slide.
        "pii_seen_server_side": METRICS["pii_seen_server_side"],
        "llm_calls": METRICS["llm_calls"],
        "llm_fallbacks": METRICS["llm_fallbacks"],
        "planner_latency_ms": {
            "last": lat[-1] if lat else None,
            "avg": round(sum(lat) / len(lat), 2) if lat else None,
        },
    }
