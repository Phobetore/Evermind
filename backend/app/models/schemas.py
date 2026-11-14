"""Pydantic input schemas. Responses are plain dicts shaped by repositories."""

from typing import Literal

from pydantic import BaseModel, Field, field_validator

from ..prompting.text import is_writable

Kind = Literal["character", "scenario"]
ProviderType = Literal["openai-compatible", "anthropic"]


def _texts(value) -> list[str]:
    """The texts in a value, at any depth of lists and JSON objects, their keys included."""
    if isinstance(value, dict):
        value = [*value, *value.values()]
    if isinstance(value, list):
        return [text for item in value for text in _texts(item)]
    return [value] if isinstance(value, str) else []


class Input(BaseModel):
    """What a request holds. Half of an emoji (a lone surrogate) comes as a JSON escape and can be
    neither stored nor sent: the field that holds one is refused, rather than a 500 once written."""

    @field_validator("*")
    @classmethod
    def _writable(cls, value):
        if not all(is_writable(text) for text in _texts(value)):
            raise ValueError("half of a character, such as a broken emoji, cannot be stored")
        return value


class LoreEntryIn(Input):
    keys: list[str]
    content: str
    enabled: bool = True


class CharacterIn(Input):
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
    lore_entries: list[LoreEntryIn] = []


class CharacterUpdate(Input):
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
    lore_entries: list[LoreEntryIn] | None = None  # the whole lorebook, in order


class CardAssistRequest(Input):
    # No upper bound here: what bounds a brief is the context of the connection that reads it.
    prompt: str = Field(min_length=3)
    kind: Kind = "character"
    connection_id: str | None = None
    existing: dict = {}
    # Sent again by a page that never heard the answer: it names the card that is already being written.
    client_id: str | None = Field(default=None, min_length=1, max_length=64)


class PersonaIn(Input):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    is_default: bool = False


class PersonaUpdate(Input):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    is_default: bool | None = None


class ConnectionIn(Input):
    name: str = Field(min_length=1, max_length=200)
    provider: ProviderType = "openai-compatible"
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    context_size: int = Field(default=16384, ge=1024, le=2_000_000)
    max_tokens: int | None = Field(default=None, ge=16, le=128_000)
    temperature: float | None = Field(default=None, ge=0, le=2)
    top_p: float | None = Field(default=None, gt=0, le=1)
    frequency_penalty: float | None = Field(default=None, ge=-2, le=2)
    presence_penalty: float | None = Field(default=None, ge=-2, le=2)
    is_default: bool = False


class ConnectionUpdate(ConnectionIn):
    """The whole connection, as for a new one."""
    api_key: str | None = None  # None = keep stored key, "" = clear it


class ConnectionDraft(ConnectionUpdate):
    id: str | None = None  # the saved connection whose key is used when none is typed


class ConversationIn(Input):
    character_id: str
    persona_id: str | None = None
    connection_id: str | None = None
    # Chosen by the page, as a message's: asked for again under it, it is the conversation made.
    client_id: str | None = Field(default=None, min_length=1, max_length=64)


class BranchIn(Input):
    client_id: str | None = Field(default=None, min_length=1, max_length=64)


class ConversationPatch(Input):
    title: str | None = None
    summary: str | None = None
    summary_was: str | None = None  # the summary the new one was typed over
    author_note: str | None = None
    connection_id: str | None = None
    wallpaper_opacity: float | None = Field(default=None, ge=0, le=1)


class MessagePatch(Input):
    content: str | None = None
    active_index: int | None = Field(default=None, ge=0)


class SettingsIn(Input):
    global_instructions: str | None = None
    auto_memory: bool | None = None
    reply_length: Literal["short", "medium", "long"] | None = None
    history_limit: int | None = Field(default=None, ge=4, le=200)
    passage_budget: int | None = Field(default=None, ge=0, le=4000)
    update_check: bool | None = None


class MemoryIn(Input):
    content: str = Field(max_length=2000)
    is_pinned: bool = False


class MemoryPatch(Input):
    content: str | None = Field(default=None, max_length=2000)
    is_pinned: bool | None = None


class ChatRequest(Input):
    conversation_id: str
    mode: Literal["send", "regenerate", "continue"] = "send"
    content: str | None = None
    # say = in-character speech/actions; narrate = the player describes the
    # world; ooc = out-of-character instruction to the model.
    message_mode: Literal["say", "narrate", "ooc"] = "say"
    # Chosen by the page for each message it sends. A page that does not know what
    # became of a message can send it again under the same one and not say it twice.
    client_id: str | None = Field(default=None, min_length=1, max_length=64)
