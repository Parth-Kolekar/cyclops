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
    # Semantic hints lifted from the page's own markup (integration plan §2.1).
    # The server may READ these to understand what an element is. It may never
    # ACT on them — every action still names the opaque id, so a hostile server
    # cannot reach a node the extractor did not curate.
    html_id: Optional[str] = None
    html_class: Optional[str] = None
    placeholder: Optional[str] = None
    aria_label: Optional[str] = None
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


class ChatTurn(BaseModel):
    """One turn of the running conversation, persisted client-side.

    Distinct from `history`, which is the machine trace of actions taken. This
    is what the human and the agent actually said to each other, so a follow-up
    like "now do the same for my brother" has something to refer back to.

    It carries placeholders only, never a raw value. That is precisely what
    makes the transcript safe to write to localStorage and safe to replay to a
    model on every step.
    """

    role: Literal["user", "assistant"]
    text: str = ""
    ts: Optional[int] = None  # epoch ms, client clock


class AvailableVaultToken(BaseModel):
    """A placeholder the client can resolve, from either vault tier.

    Richer than the redaction manifest's counts: it names the exact token and
    says which tier it came from, so the planner can reach for a remembered
    value that is not visible anywhere on the current page.
    """

    token: str
    kind: str
    source: Literal["session", "persistent"] = "session"
    label: str = ""
    id: Optional[str] = None


class SanitizedPayload(BaseModel):
    schema_: str = Field("cyclops.payload.v3", alias="schema")
    session_id: str
    step: int = 0
    goal: str = ""
    history: list[ActionRecord] = Field(default_factory=list)
    # The continuous conversation, loaded from localStorage by the extension.
    chat_history: list[ChatTurn] = Field(default_factory=list)
    # Placeholders the client can resolve, from the session and persistent tiers.
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
# Fifteen verbs, expanded from seven when the browser-automation toolset was
# merged in (integration plan §3). The cap still means something: every verb
# here must be one executor.js can genuinely perform. Advertising a capability
# the extension does not have is how you get a model that confidently emits
# actions which silently do nothing.
#
# The privacy boundary is unchanged. Element-addressed verbs name an opaque id
# (`e3`) and never a CSS selector, so the server can only ever reach nodes the
# extractor already curated.


class Click(BaseModel):
    action: Literal["click"]
    target: str
    reason: str = ""


class DoubleClick(BaseModel):
    action: Literal["double_click"]
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


class PressKey(BaseModel):
    action: Literal["press_key"]
    key: str
    # Omitted means "press into whatever is focused" — the click-then-type
    # workflow their prompt leans on.
    target: Optional[str] = None
    reason: str = ""


class Scroll(BaseModel):
    action: Literal["scroll"]
    # No left/right: executor.js scrolls vertically only.
    direction: Literal["up", "down", "top", "bottom"]
    amount_px: Optional[int] = None
    reason: str = ""


class Navigate(BaseModel):
    action: Literal["navigate"]
    host: str
    path: str
    reason: str = ""


class GoBack(BaseModel):
    action: Literal["goback"]
    reason: str = ""


class Reload(BaseModel):
    action: Literal["reload"]
    reason: str = ""


class Wait(BaseModel):
    action: Literal["wait"]
    seconds: float = 1.0
    reason: str = ""


class ExtractText(BaseModel):
    action: Literal["extract_text"]
    reason: str = ""


class AskUser(BaseModel):
    action: Literal["ask_user"]
    question: str
    # The kind of value being requested, when it is personal data. The vault
    # mints a token from the answer instead of letting the raw value into the
    # transcript, and this is how it knows which kind to mint.
    expects: Optional[str] = None
    reason: str = ""


class ChatResponse(BaseModel):
    action: Literal["chat_response"]
    message: str
    reason: str = ""


class ExecuteJs(BaseModel):
    """Arbitrary JavaScript in the page.

    SECURITY: this verb runs in the live page, where the DOM still holds the
    user's REAL data — redaction happens on the way out, not in the page. Code
    here can therefore read an Aadhaar directly and is not constrained by the
    vault, the redaction manifest, or either PII guard. It is retained on an
    explicit product decision (integration plan §2.5) as a last resort for
    canvas editors. Treat every use as outside the privacy guarantee.
    """

    action: Literal["execute_js"]
    code: str
    return_result: bool = False
    reason: str = ""


class Exit(BaseModel):
    action: Literal["exit"]
    summary: str = ""


AnyAction = Union[
    Click,
    DoubleClick,
    Fill,
    Select,
    PressKey,
    Scroll,
    Navigate,
    GoBack,
    Reload,
    Wait,
    ExtractText,
    AskUser,
    ChatResponse,
    ExecuteJs,
    Exit,
]


class Plan(BaseModel):
    steps: list[AnyAction]
    confidence: float = 1.0
    needs_pixels_next: bool = False
    # Which brain produced this. Shown in the popup trace so a demo can tell
    # the rule-based stub apart from the real planner at a glance.
    planner: str = "stub"
