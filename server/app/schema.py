"""Shared data contracts. Mirror of the client-side shapes.

Phase 0 keeps the payload loose (elements carry raw values, no redaction
manifest yet). Phase 2 tightens this once the sanitiser exists.
"""

from typing import Literal, Optional, Union

from pydantic import BaseModel, Field

# --------------------------------------------------------------- inbound


class PageInfo(BaseModel):
    url_host: str = ""
    title: str = ""
    kind: str = "unknown"
    kind_confidence: float = 0.0
    kind_source: str = "heuristic"


class Viewport(BaseModel):
    w: int = 0
    h: int = 0
    scroll_x: int = 0
    scroll_y: int = 0
    dpr: float = 1.0
    norm_width: int = 1024
    norm_scale: float = 1.0


class PiiAnnotation(BaseModel):
    """Says *that* an element holds PII and of what kind. Never the value."""

    kind: str
    confidence: float = 0.0
    detector: str = "regex"


class RedactionManifest(BaseModel):
    """Tells the server what vocabulary of placeholders to expect.

    This is what satisfies "the server should be aware of the redaction scheme
    and process data accordingly" — the prompt is templated with it.
    """

    scheme: str = "cyclops.redact.v1"
    token_types: list[str] = Field(default_factory=list)
    counts: dict[str, int] = Field(default_factory=dict)
    regions_masked: int = 0
    method: Literal["opaque_fill", "blur", "mixed"] = "opaque_fill"


class Element(BaseModel):
    id: str
    role: str
    label: str = ""
    text: Optional[str] = None
    value: Optional[str] = None
    # [x, y, w, h] in the normalised 1024px-wide coordinate space
    bbox: list[float] = Field(default_factory=list)
    visible: bool = True
    enabled: bool = True
    focused: bool = False
    input_type: Optional[str] = None
    autocomplete: Optional[str] = None
    options: Optional[list[str]] = None  # for <select>
    source: Literal["dom", "vision"] = "dom"
    # This element currently holds PII (already replaced by a placeholder).
    pii: Optional[PiiAnnotation] = None
    # This element is a field *for* PII of this kind, whether or not it holds
    # any yet. Drives both planning and the vault's kind-compatibility check.
    pii_expects: Optional[str] = None


class OpaqueRegion(BaseModel):
    """A canvas/img/video the DOM cannot describe — the vision model's job."""

    tag: str
    bbox: list[float] = Field(default_factory=list)
    described: bool = False


class ActionRecord(BaseModel):
    action: dict
    ok: bool = True
    note: Optional[str] = None


class AvailableVaultToken(BaseModel):
    token: str
    kind: str
    source: Literal["session", "persistent"] = "session"
    label: str = ""
    id: Optional[str] = None


class SanitizedPayload(BaseModel):
    schema_: str = Field("cyclops.payload.v2", alias="schema")
    session_id: str
    step: int = 0
    goal: str = ""
    history: list[ActionRecord] = Field(default_factory=list)
    available_vault_tokens: list[AvailableVaultToken] = Field(default_factory=list)
    page: PageInfo = Field(default_factory=PageInfo)
    viewport: Viewport = Field(default_factory=Viewport)
    elements: list[Element] = Field(default_factory=list)
    opaque_regions: list[OpaqueRegion] = Field(default_factory=list)
    redaction_manifest: RedactionManifest = Field(default_factory=RedactionManifest)
    needs_pixels: bool = False
    image_base64: Optional[str] = None

    model_config = {"populate_by_name": True}


# ------------------------------------------------------- outbound (Action DSL)
# Seven verbs. Resist adding more. (design doc §4.3)


class Click(BaseModel):
    action: Literal["click"]
    target: str
    reason: str = ""


class Fill(BaseModel):
    action: Literal["fill"]
    target: str
    value: str
    reason: str = ""


class Select(BaseModel):
    action: Literal["select"]
    target: str
    option: str
    reason: str = ""


class Scroll(BaseModel):
    action: Literal["scroll"]
    direction: Literal["up", "down", "top", "bottom"]
    amount_px: Optional[int] = None
    reason: str = ""


class Navigate(BaseModel):
    action: Literal["navigate"]
    host: str
    path: str
    reason: str = ""


class AskUser(BaseModel):
    action: Literal["ask_user"]
    question: str


class Done(BaseModel):
    action: Literal["done"]
    summary: str = ""


AnyAction = Union[Click, Fill, Select, Scroll, Navigate, AskUser, Done]


class Plan(BaseModel):
    steps: list[AnyAction]
    confidence: float = 1.0
    needs_pixels_next: bool = False
    # Which brain produced this. Shown in the popup trace so a demo can tell
    # the rule-based stub apart from the real planner at a glance.
    planner: str = "stub"
