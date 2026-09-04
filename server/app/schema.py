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


class Viewport(BaseModel):
    w: int = 0
    h: int = 0
    scroll_x: int = 0
    scroll_y: int = 0
    dpr: float = 1.0


class Element(BaseModel):
    id: str
    role: str
    label: str = ""
    value: Optional[str] = None
    bbox: list[float] = Field(default_factory=list)
    enabled: bool = True
    input_type: Optional[str] = None
    source: Literal["dom", "vision"] = "dom"


class ActionRecord(BaseModel):
    action: dict
    ok: bool = True
    note: Optional[str] = None


class SanitizedPayload(BaseModel):
    schema_: str = Field("cyclops.payload.v0", alias="schema")
    session_id: str
    step: int = 0
    goal: str = ""
    history: list[ActionRecord] = Field(default_factory=list)
    page: PageInfo = Field(default_factory=PageInfo)
    viewport: Viewport = Field(default_factory=Viewport)
    elements: list[Element] = Field(default_factory=list)
    needs_pixels: bool = False

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
