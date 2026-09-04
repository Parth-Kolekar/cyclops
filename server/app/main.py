"""Cyclops server — FastAPI entrypoint.

Phase 0: one real endpoint (/v1/plan) backed by a rule-based stub planner,
plus health and metrics so the popup has something to light up.
"""

import time

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .planner import stub
from .schema import Plan, SanitizedPayload

app = FastAPI(title="Cyclops", version="0.1.0")

# The extension calls in from a chrome-extension:// origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

STARTED_AT = time.time()
METRICS = {"requests": 0, "latency_ms": []}


@app.get("/v1/health")
def health():
    return {
        "ok": True,
        "service": "cyclops",
        "planner": "stub",
        "phase": 0,
        "uptime_s": round(time.time() - STARTED_AT, 1),
    }


@app.post("/v1/plan", response_model=Plan)
def plan(payload: SanitizedPayload):
    t0 = time.perf_counter()
    result = stub.plan(payload)
    took = (time.perf_counter() - t0) * 1000

    METRICS["requests"] += 1
    METRICS["latency_ms"].append(round(took, 2))
    METRICS["latency_ms"] = METRICS["latency_ms"][-200:]

    print(
        f'[plan] step={payload.step} elements={len(payload.elements)} '
        f'goal="{payload.goal[:48]}" -> {result.steps[0].action} ({took:.1f} ms)'
    )
    return result


@app.get("/v1/metrics")
def metrics():
    lat = METRICS["latency_ms"]
    return {
        "requests": METRICS["requests"],
        "planner_latency_ms": {
            "last": lat[-1] if lat else None,
            "avg": round(sum(lat) / len(lat), 2) if lat else None,
        },
    }
