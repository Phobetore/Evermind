"""Pydantic input schemas. Responses are plain dicts shaped by repositories."""

from typing import Literal

from pydantic import BaseModel, Field

Kind = Literal["character", "scenario"]
ProviderType = Literal["openai-compatible", "anthropic"]


class CharacterIn(BaseModel):
    kind: Kind = "character"
    name: str = Field(min_length=1, max_length=200)
    tagline: str = ""
    description: str = ""
    personality: str = ""
    scenario: str = ""
    greeting: str = ""
    alternate_greetings: list[str] = []
    example_dialogues: str = ""
    system_prompt: str = ""
    post_history_instructions: str = ""
    creator_notes: str = ""
    tags: list[str] = []
    creator: str = ""
    character_version: str = ""


class CharacterUpdate(BaseModel):
    kind: Kind | None = None
    name: str | None = Field(default=None, min_length=1, max_length=200)
    tagline: str | None = None
    description: str | None = None
    personality: str | None = None
    scenario: str | None = None
    greeting: str | None = None
    alternate_greetings: list[str] | None = None
    example_dialogues: str | None = None
    system_prompt: str | None = None
    post_history_instructions: str | None = None
    creator_notes: str | None = None
    tags: list[str] | None = None
    creator: str | None = None
    character_version: str | None = None
    is_favorite: bool | None = None


class CardAssistRequest(BaseModel):
    prompt: str = Field(min_length=3, max_length=8000)
    kind: Kind = "character"
    connection_id: str | None = None
    existing: dict = {}


class PersonaIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    is_default: bool = False


class PersonaUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    is_default: bool | None = None


class ConnectionIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    provider: ProviderType = "openai-compatible"
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    context_size: int = Field(default=16384, ge=1024, le=2_000_000)
    max_tokens: int = Field(default=1024, ge=16, le=128_000)
    temperature: float = Field(default=0.8, ge=0, le=2)
    top_p: float = Field(default=0.95, gt=0, le=1)
    frequency_penalty: float = Field(default=0.15, ge=-2, le=2)
    presence_penalty: float = Field(default=0.15, ge=-2, le=2)
    extra_params: dict = {}
    is_default: bool = False


class ConnectionUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    provider: ProviderType | None = None
    base_url: str | None = None
    api_key: str | None = None  # None = keep stored key, "" = clear it
    model: str | None = None
    context_size: int | None = Field(default=None, ge=1024, le=2_000_000)
    max_tokens: int | None = Field(default=None, ge=16, le=128_000)
    temperature: float | None = Field(default=None, ge=0, le=2)
    top_p: float | None = Field(default=None, gt=0, le=1)
    frequency_penalty: float | None = Field(default=None, ge=-2, le=2)
    presence_penalty: float | None = Field(default=None, ge=-2, le=2)
    extra_params: dict | None = None
    is_default: bool | None = None


class ConversationIn(BaseModel):
    character_id: str
    persona_id: str | None = None
    connection_id: str | None = None
    greeting_index: int = Field(default=0, ge=0)


class ConversationPatch(BaseModel):
    title: str | None = None
    summary: str | None = None
    author_note: str | None = None
    persona_id: str | None = None
    connection_id: str | None = None
    wallpaper_opacity: float | None = Field(default=None, ge=0, le=1)


class MessagePatch(BaseModel):
    content: str | None = None
    active_index: int | None = Field(default=None, ge=0)


class SettingsIn(BaseModel):
    default_connection_id: str | None = None
    default_persona_id: str | None = None
    global_instructions: str | None = None
    auto_memory: bool | None = None
    reply_length: Literal["short", "medium", "long"] | None = None
    history_limit: int | None = Field(default=None, ge=4, le=200)
    passage_budget: int | None = Field(default=None, ge=0, le=4000)
    update_check: bool | None = None


class LoreEntryIn(BaseModel):
    keys: list[str] = Field(min_length=1)
    content: str = Field(min_length=1, max_length=4000)
    enabled: bool = True
    case_sensitive: bool = False
    priority: int = 0


class LoreEntryPatch(BaseModel):
    keys: list[str] | None = None
    content: str | None = Field(default=None, min_length=1, max_length=4000)
    enabled: bool | None = None
    case_sensitive: bool | None = None
    priority: int | None = None


class MemoryIn(BaseModel):
    content: str = Field(min_length=1, max_length=2000)
    kind: Literal["fact", "event", "relationship", "promise", "state"] = "fact"
    is_pinned: bool = False


class MemoryPatch(BaseModel):
    content: str | None = Field(default=None, min_length=1, max_length=2000)
    is_pinned: bool | None = None


class ChatRequest(BaseModel):
    conversation_id: str
    mode: Literal["send", "regenerate", "continue"] = "send"
    content: str | None = None
    # say = in-character speech/actions; narrate = the player describes the
    # world; ooc = out-of-character instruction to the model.
    message_mode: Literal["say", "narrate", "ooc"] = "say"
