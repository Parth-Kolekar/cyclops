"""Cyclops server — FastAPI entrypoint.

Phase 2: every inbound payload is independently re-scanned for PII before it
reaches the planner, and rejected outright if anything got through.
"""

import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .guard import verifier
from .planner import stub
from .schema import Plan, SanitizedPayload

app = FastAPI(title="Cyclops", version="0.2.0")

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
}


@app.get("/v1/health")
def health():
    return {
        "ok": True,
        "service": "cyclops",
        "planner": "stub",
        "phase": 2,
        "guard": "enabled",
        "uptime_s": round(time.time() - STARTED_AT, 1),
    }


@app.post("/v1/plan", response_model=Plan)
def plan(payload: SanitizedPayload):
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
        print(f"[guard] REJECTED payload — unsanitised {kinds}")
        raise HTTPException(
            status_code=422,
            detail={"error": "unsanitized_payload", "kinds": kinds, "count": len(hits)},
        )

    METRICS["clean"] += 1
    result = stub.plan(payload)
    took = (time.perf_counter() - t0) * 1000
    METRICS["latency_ms"] = (METRICS["latency_ms"] + [round(took, 2)])[-200:]

    manifest = payload.redaction_manifest
    print(
        f"[plan] step={payload.step} elements={len(payload.elements)} "
        f"tokens={manifest.regions_masked} {manifest.token_types} "
        f'goal="{payload.goal[:40]}" -> {result.steps[0].action} ({took:.1f} ms)'
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


@app.get("/v1/metrics")
def metrics():
    lat = METRICS["latency_ms"]
    return {
        "requests": METRICS["requests"],
        "payloads_clean": METRICS["clean"],
        "payloads_rejected": METRICS["rejected"],
        # The line for the results slide.
        "pii_seen_server_side": METRICS["pii_seen_server_side"],
        "planner_latency_ms": {
            "last": lat[-1] if lat else None,
            "avg": round(sum(lat) / len(lat), 2) if lat else None,
        },
    }
