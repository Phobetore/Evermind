"""Pydantic input schemas. Responses are plain dicts shaped by repositories."""

from typing import Annotated, Any, Literal

from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from ..prompting.text import is_writable

Kind = Literal["character", "scenario"]
ProviderType = Literal["openai-compatible", "anthropic"]
Role = Literal["system", "user", "assistant"]
WHOLE = 2**53 - 1  # the largest whole number JSON and JavaScript both hold exactly
Family = Literal["ollama", "lmstudio", "llamacpp", "koboldcpp", "openrouter", "openai",
                 "anthropic", "groq", "mistral", "generic"]
# A page from before AIs names a connection, which is now an AI or the service holding it.
_AI = AliasChoices("model_id", "connection_id")


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
    text: str = Field(min_length=2)   # the card's JSON as its file held it, decoded from UTF-8; "{}" at the least
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
    # The card assistant's jobs that wrote a card not saved yet: its first save claims their rows.
    assist_jobs: list[Annotated[str, Field(min_length=1, max_length=64)]] = Field(
        default=[], max_length=50)

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
    # No upper bound here: what bounds a brief is the context of the AI that reads it.
    prompt: str = Field(min_length=3)
    kind: Kind = "character"
    model_id: str | None = Field(default=None, validation_alias=_AI)
    existing: dict = {}
    # Sent again by a page that never heard the answer: it names the card that is already being written.
    client_id: str | None = Field(default=None, min_length=1, max_length=64)
    # The saved card being written, which the call's row names; none for a card not saved yet.
    card_id: str | None = Field(default=None, min_length=1, max_length=64)


class PersonaIn(Input):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    is_default: bool = False


class PersonaUpdate(Input):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    is_default: bool | None = None


class ServiceRef(Input):
    """A service as the page names it: a saved one by its id alone, or a draft that says its
    API and address (with the id of the saved one it was started from, if any). A key left out
    (None) is the saved one's, lent only to the address it was given for; "" is no key."""
    id: str | None = Field(default=None, min_length=1)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    provider: ProviderType | None = None
    base_url: str | None = None
    api_key: str | None = None
    family: Family | None = None

    @model_validator(mode="after")
    def _saved_or_draft(self):
        draft = self.provider is not None and self.base_url is not None
        if not draft and (self.id is None or self.provider is not None or self.base_url is not None):
            raise ValueError("a service is named by its id, or drafted with its API and address")
        return self

    @property
    def draft(self) -> bool:
        return self.provider is not None


class ProbeIn(ServiceRef):
    fresh: bool = False  # past the list kept for ten minutes


class ConnectionBefore(Input):
    """What a page from before AIs sends to test a connection: its form, of which only the
    service is read."""
    id: str | None = None
    provider: ProviderType = "openai-compatible"
    base_url: str = ""
    api_key: str | None = None


class ServiceUpdate(Input):
    # Anything else is what a page from before AIs sends of a whole connection, and refused whole.
    model_config = ConfigDict(extra="allow")

    name: str | None = Field(default=None, min_length=1, max_length=200)
    provider: ProviderType | None = None
    base_url: str | None = None
    api_key: str | None = None  # None keeps the key, "" clears it


class NewModel(Input):
    model: str = Field(min_length=1)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    context_own: int | None = Field(default=None, ge=512, le=WHOLE)
    price_own_in: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    price_own_out: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    # The model as the probe relayed it, sent back: read again by catalog.whole and amount, so
    # that a field of an odd shape is not told rather than refused.
    read: dict | None = None


class ModelsCreate(Input):
    service: ServiceRef
    models: list[NewModel] = Field(min_length=1)
    conversation_id: str | None = None


class ReplyCap(Input):
    mode: Literal["auto", "unsent", "fixed"]
    tokens: int | None = Field(default=None, ge=1, le=WHOLE)

    @model_validator(mode="after")
    def _fixed_has_tokens(self):
        if self.mode == "fixed" and self.tokens is None:
            raise ValueError("a fixed ceiling needs its number of tokens")
        return self


class ModelUpdate(Input):
    # No maximum of Evermind's own: the bounds are what JSON holds whole, the floor of the
    # engine's budget (512) and the ranges the APIs take for the four settings.
    name: str | None = Field(default=None, min_length=1, max_length=200)
    model: str | None = Field(default=None, min_length=1)
    is_default: Literal[True] | None = None  # another is made the default by marking it
    context_own: int | None = Field(default=None, ge=512, le=WHOLE)
    reply_cap: ReplyCap | None = None
    temperature: float | None = Field(default=None, ge=0, le=2)
    top_p: float | None = Field(default=None, gt=0, le=1)
    frequency_penalty: float | None = Field(default=None, ge=-2, le=2)
    presence_penalty: float | None = Field(default=None, ge=-2, le=2)
    price_own_in: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    price_own_out: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    notices_kept: bool | None = None


class RefreshIn(Input):
    fresh: bool = False


class ObservedIn(Input):
    # What a reply was seen read at: no less than the floor of the engine's budget.
    tokens: int = Field(ge=512, le=WHOLE, strict=True)


Length = Literal["short", "medium", "long"]
Reminders = Literal["essential", "normal", "rich", "all"]
# A whole number JSON and JavaScript both hold exactly, never negative.
Count = Annotated[int, Field(ge=0, le=WHOLE)]
Share = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]


class PlayOverrides(Input):
    """What one conversation changes of its way, for itself."""
    history_limit: Count | None = None  # 0: the whole story
    reply_length: Length | None = None
    reminders: Reminders | None = None


class ConversationIn(Input):
    character_id: str
    persona_id: str | None = None
    model_id: str | None = Field(default=None, validation_alias=_AI)
    play_style: str | None = None  # left out: the way offered to new conversations
    # Chosen by the page, as a message's: asked for again under it, it is the conversation made.
    client_id: str | None = Field(default=None, min_length=1, max_length=64)


class BranchIn(Input):
    client_id: str | None = Field(default=None, min_length=1, max_length=64)


class ConversationPatch(Input):
    title: str | None = None
    summary: str | None = None
    summary_was: str | None = None  # the summary the new one was typed over
    author_note: str | None = None
    model_id: str | None = Field(default=None, validation_alias=_AI)
    model_lost_seen: Literal[True] | None = None  # the line saying an AI was removed was seen
    backdrop: Literal["auto", "none", "image"] | None = None
    backdrop_strength: float | None = Field(default=None, ge=0, le=1)  # null: the device's
    # The strength of the chosen picture. A page opened before backdrops still sends it.
    wallpaper_opacity: float | None = Field(default=None, ge=0, le=1)
    play_style: str | None = None  # another way chosen: what was adjusted of the last one goes
    play_overrides: PlayOverrides | None = None  # null: nothing adjusted


class MessagePatch(Input):
    content: str | None = None
    active_index: int | None = Field(default=None, ge=0)


class SettingsIn(Input):
    global_instructions: str | None = None
    auto_memory: bool | None = None
    update_check: bool | None = None
    # The way of playing before ways existed, which only a page from before sends: declared to be
    # refused (410), whatever their value, even one out of the bounds they had.
    reply_length: Any = None
    history_limit: Any = None
    passage_budget: Any = None


class WayIn(Input):
    """A way's fields, each left out when unchanged. Floors only, no maximum: a person may
    reread the whole of a long story, or give a model with a vast window all it holds."""
    # 0: the whole story. 2^53 - 1: what JSON and JavaScript both hold exactly.
    history_limit: Count | None = None
    reply_length: Length | None = None
    # None: the room is left to the AI. A reply needs at least one token.
    reply_room: int | None = Field(default=None, ge=1, le=WHOLE)
    # None: no cap. 0 leaves the reminder out.
    facts_cap: Count | None = None
    # None: as many as the room holds. 0 facts would be no facts: the cap of 0 says that.
    max_facts: int | None = Field(default=None, ge=1, le=WHOLE)
    lore_cap: Count | None = None
    lore_share: Share | None = None  # of the prompt's budget; None: no share
    passage_cap: Count | None = None
    passage_share: Share | None = None
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1,
                                           max_length=60)] | None = None

    @model_validator(mode="after")
    def _no_empty_value(self):
        # These three have no "none": a null sent for them is a mistake, not a choice.
        for key in ("history_limit", "reply_length", "name"):
            if key in self.model_fields_set and getattr(self, key) is None:
                raise ValueError(f"{key} cannot be null")
        return self


class WayCopyIn(Input):
    from_id: str = Field(validation_alias="from")
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]


class WayDefaultIn(Input):
    id: str


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
