"""Pydantic input schemas. Responses are plain dicts shaped by repositories."""

from typing import Literal

from pydantic import BaseModel, Field, field_validator

from ..prompting.text import is_writable

Kind = Literal["character", "scenario"]
ProviderType = Literal["openai-compatible", "anthropic"]
Role = Literal["system", "user", "assistant"]
WHOLE = 2**53 - 1  # the largest whole number JSON and JavaScript both hold exactly


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


class OriginalCardIn(Input):
    text: str = Field(min_length=2)   # the card's JSON as its file held it, decoded from UTF-8
    format: Literal["png", "json"]
    other_text: str | None = None     # the PNG's other card chunk, when it reads differently
    read: "CharacterIn"               # what the reader made of the card; its own `card` is ignored


class LoreEntryIn(Input):
    keys: list[str]
    content: str
    enabled: bool = True
    origin: int | None = Field(default=None, ge=0, le=WHOLE)
    comment: str = ""
    constant: bool = False
    selective: bool = False
    secondary_keys: list[str] = []
    selective_logic: int = Field(default=0, ge=0, le=3)
    insertion_order: int = Field(default=100, ge=-WHOLE, le=WHOLE)
    position: int = Field(default=1, ge=0, le=7)
    depth: int = Field(default=4, ge=0, le=WHOLE)
    role: Role = "system"
    whole_words: bool = True
    exclude_recursion: bool = False
    prevent_recursion: bool = False


def _one_entry_per_origin(entries: list[LoreEntryIn] | None) -> list[LoreEntryIn] | None:
    # The export writes each entry over the entry of the card it came from: two would fight over it.
    origins = [entry.origin for entry in entries or [] if entry.origin is not None]
    if len(origins) != len(set(origins)):
        raise ValueError("two entries cannot come from the same entry of the card")
    return entries


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
    # Left out by a page from before the rules existed: its card keeps the old ones until re-read.
    card_rules: Literal[1, 2] = 1
    nickname: str = Field(default="", max_length=200)
    character_note: str = ""
    character_note_depth: int = Field(default=4, ge=0, le=WHOLE)
    character_note_role: Role = "system"
    creator_notes_multilingual: dict[str, str] = {}
    card: OriginalCardIn | None = None

    _lore_entries = field_validator("lore_entries")(_one_entry_per_origin)


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
    card_rules: Literal[1, 2] | None = None
    nickname: str | None = Field(default=None, max_length=200)
    character_note: str | None = None
    character_note_depth: int | None = Field(default=None, ge=0, le=WHOLE)
    character_note_role: Role | None = None
    creator_notes_multilingual: dict[str, str] | None = None
    card: OriginalCardIn | None = None

    _lore_entries = field_validator("lore_entries")(_one_entry_per_origin)


OriginalCardIn.model_rebuild()  # its reading is a CharacterIn, declared after it


class CardAssistRequest(Input):
    prompt: str = Field(min_length=3, max_length=8000)
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
