export type Kind = "character" | "scenario";
export type ProviderType = "openai-compatible" | "anthropic";
export type NoteRole = "system" | "user" | "assistant";

export type Backdrop = "auto" | "none" | "image";

export interface Character {
  id: string;
  kind: Kind;
  name: string;
  tagline: string;
  description: string;
  personality: string;
  scenario: string;
  greeting: string;
  alternate_greetings: string[];
  example_dialogues: string;
  system_prompt: string;
  post_history_instructions: string;
  creator_notes: string;
  tags: string[];
  creator: string;
  character_version: string;
  nickname: string;
  character_note: string;
  character_note_depth: number;
  character_note_role: NoteRole;
  creator_notes_multilingual: Record<string, string>;
  /** 1: the rules every card had before cards were kept whole; 2: those community cards are written for. */
  card_rules: 1 | 2;
  /** Whether the card it was read from is kept, for its export. */
  has_card: boolean;
  avatar_url: string | null;
  /** The portrait at 480 px wide, made by a browser; null until one has. */
  avatar_thumb_url: string | null;
  /** The portrait at 960 px wide, for the backdrop of a conversation; null until made. */
  avatar_backdrop_url: string | null;
  is_favorite: boolean;
  created_at: string;
  updated_at: string;
}

/** What the home page draws of a card: none of the long fields, which make the full list megabytes. */
export interface CharacterTile extends Pick<Character,
  "id" | "kind" | "name" | "nickname" | "tagline" | "tags" | "avatar_url" | "avatar_thumb_url"
  | "is_favorite" | "card_rules" | "created_at" | "updated_at"> {
  /** The first real sentence of the description, "" when it has none (engine/excerpt.ts). */
  excerpt: string;
}

export interface Persona {
  id: string;
  name: string;
  description: string;
  avatar_url: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

/** Who serves models: the chips of the add flow, or "generic" for any other address. */
export type Family = "ollama" | "lmstudio" | "llamacpp" | "koboldcpp" | "openrouter" | "openai"
  | "anthropic" | "groq" | "mistral" | "generic";

/** A server and its key, kept once for every AI on it. The key never leaves the server. */
export interface Service {
  id: string;
  name: string;
  provider: ProviderType;
  family: Family;
  base_url: string;
  /** At home rather than a paid service, as its address says. */
  local: boolean;
  /** On this PC rather than elsewhere on the network. */
  loopback: boolean;
  api_key_set: boolean;
  api_key_hint: string;
  model_count: number;
  created_at: string;
  updated_at: string;
}

/** An AI: one model chosen on a service, as the server describes it. */
export interface Ai {
  id: string;
  service: Pick<Service, "id" | "name" | "family" | "local" | "loopback" | "provider" | "base_url"
    | "api_key_set" | "api_key_hint">;
  /** The server's own id of the model. */
  model: string;
  name: string;
  is_default: boolean;
  context: {
    /** Typed by the person; null follows what was read. */
    own: number | null;
    read: number | null;
    read_kind: "served" | "configured" | "observed" | "max" | null;
    /** What Evermind counts it reads at once, and where that figure comes from. */
    used: number;
    source: "own" | "read" | "size_untold" | "assumed";
  };
  output_read: number | null;
  /** Whether it reasons before it writes; null while nothing has said. */
  reasons: boolean | null;
  /** USD per million tokens, read from the server or typed. */
  price: { read_in: number | null; read_out: number | null; own_in: number | null; own_out: number | null; varies: boolean };
  /** The server's own word: read, never worked out again here. */
  free: boolean;
  /** What a hundred of its replies cost, measured; null under 20 replies whose price is known. */
  per100: Per100 | null;
  limits_read_at: string | null;
  reply_cap: { mode: "auto" | "unsent" | "fixed"; tokens: number | null };
  /** Null leaves a setting to the model: it is not sent. */
  temperature: number | null;
  top_p: number | null;
  frequency_penalty: number | null;
  presence_penalty: number | null;
  /** Made from a connection by the update to AIs. */
  migrated: boolean;
  notices: ("follow_server" | "let_evermind" | "long_room")[];
  /** What the prompt leaves unused under the window, as the server counts it for this AI. */
  margin: number;
  /** The server's tokens for each one the engine estimates; null until a reply has measured it. */
  token_ratio: number | null;
  /** What its whole replies took, by length, as measured; null until one was. */
  reply_tokens: Record<Length, number | null>;
  /** What a model that reasons is given on top of the reply for its thinking. */
  thinking_allowance: number;
  thinking_measured: boolean;
  /** Whether its server says what it counts; null until a reply has said either. */
  usage_seen: boolean | null;
  /** Reached by Anthropic's own API, which must be sent a ceiling. */
  anthropic: boolean;
  conversation_count: number;
  created_at: string;
  updated_at: string;
}

/** A model as the server's list gives it, field for field what the probe relays. */
export interface ProbeModel {
  id: string;
  name: string;
  vendor: string | null;
  created: number | null;
  context: { served: number | null; configured: number | null; max: number | null };
  max_output: number | null;
  price: { input: number | null; output: number | null; varies: boolean; cache_read: number | null; cache_write: number | null };
  reasons: boolean | null;
}

/** Every model a service's server lists, as it was read. */
export interface ProbeResult {
  family: Family;
  local: boolean;
  read_at: string;
  /** The saved service this one is, if it is one: its models are then already among the AIs. */
  service_id: string | null;
  dropped: { batch: number };
  models: ProbeModel[];
}

export interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  variants: string[];
  active_index: number;
  position: number;
  meta: Record<string, unknown>;
  created_at: string;
}

export type Length = "short" | "medium" | "long";
export type Reminders = "essential" | "normal" | "rich" | "all";
/** What one conversation changes of its way of playing, for itself alone. */
export interface PlayOverrides {
  history_limit?: number;
  reply_length?: Length;
  reminders?: Reminders;
}

export interface Conversation {
  id: string;
  character_id: string;
  persona_id: string | null;
  /** The AI that answers it; null when there is none. */
  model_id: string | null;
  /** The name of an AI removed while it answered this conversation, until that is seen. */
  model_lost: string | null;
  title: string;
  summary: string;
  author_note?: string;
  /** Why the memory's pass (automatic, or a Remember) or a Condense last failed, and which one,
   *  until that work succeeds. */
  memory_error?: { error: string; kind?: string; reason?: string; operation?: "pass" | "extract" | "consolidate" } | null;
  /** Whether a memory pass or a consolidation is under way. */
  memory_running?: boolean;
  /** Which, while one is: the automatic pass, a Remember or a consolidation, asked from wherever. */
  memory_operation?: "pass" | "extract" | "consolidate" | null;
  wallpaper_url?: string | null;
  wallpaper_opacity?: number;
  backdrop: Backdrop;
  /** Its own strength, 0 to 1; null follows the device's. */
  backdrop_strength: number | null;
  /** The way of playing it was made with, or chosen since; an id no longer known plays the way
   *  offered to new conversations. */
  play_style: string;
  /** What it adjusted of its way for itself; null when nothing. */
  play_overrides: PlayOverrides | null;
  forked_from?: string | null;
  /** Counts the changes to its messages. */
  revision?: number;
  created_at: string;
  updated_at: string;
  character?: Character;
  messages?: Message[];
  message_count?: number;
  last_message_at?: string | null;
}

export interface ContextStats {
  used_tokens: number;
  budget: number;
  context_size: number;
  messages_included: number;
  messages_total: number;
  lore_matched: number;
  /** What the card, the reminders and the story took of what was read. */
  parts?: { card: number; reminders: number; history: number };
  /** What the prompt kept for the reply. */
  reply_room?: number;
  /** How many messages the way asked to reread; 0: all of them. */
  history_limit?: number;
}

/** A way of playing, field for field: how much of the story is reread, how long a reply runs,
 *  how much room the reminders take. null: no cap, no share, or the room left to the AI. */
export interface WayFields {
  /** 0: the whole story. */
  history_limit: number;
  reply_length: Length;
  reply_room: number | null;
  facts_cap: number | null;
  max_facts: number | null;
  lore_cap: number | null;
  lore_share: number | null;
  passage_cap: number | null;
  passage_share: number | null;
}

/** name is null for a built-in way and for "mine", which the interface names in its language. */
export interface Way extends WayFields {
  id: string;
  name: string | null;
  built_in: boolean;
  /** A built-in way changed from its own figures. */
  overridden: boolean;
}

export interface WayListed extends Way {
  /** How many conversations play it. */
  conversations: number;
}

export interface Ways {
  /** The way offered to new conversations. */
  default: string;
  /** Whether past passages can be found again on this server. */
  passages_available: boolean;
  ways: WayListed[];
}

/** What an AI would read of a conversation under a way, worked out without asking a model, in
 *  the server's tokens. */
export interface OutlookEntry {
  model_id: string | null;
  play_style: string;
  used_tokens: number;
  budget: number;
  context_size: number;
  messages_included: number;
  messages_total: number;
  history_limit: number;
  reply_room: number;
  /** What the turn keeps for the reply: the way's room as this AI is sent it, with its thinking,
   *  under its own ceiling or none. Absent from a server that does not say it. */
  reply_kept?: number;
  parts: { card: number; reminders: number; history: number };
  /** The ceiling of its own that keeps the reply under the way's room; null when none does. */
  cap_short: number | null;
}

/** The conversation's AI under its way, then every AI under its way, then every way with its AI. */
export interface Outlook {
  current: OutlookEntry & { way: Way & { adjusted: boolean } };
  models: OutlookEntry[];
  ways: (OutlookEntry & { way: Way })[];
}

export interface TurnPerf {
  gen_seconds: number;
  first_token_seconds: number;
  tokens_per_s: number | null;
}

/** A lorebook entry. The id only tells entries apart in the form: the lorebook is
 *  saved whole, with the card. */
export interface LoreEntry {
  id: string;
  keys: string[];
  content: string;
  enabled: boolean;
  /** The index of the entry of the kept card this one comes from; null for one made here. */
  origin: number | null;
  comment: string;
  constant: boolean;
  selective: boolean;
  secondary_keys: string[];
  /** 0 and any, 1 not all, 2 none, 3 all: SillyTavern's numbering. */
  selective_logic: 0 | 1 | 2 | 3;
  insertion_order: number;
  /** SillyTavern's numbering, 0 to 7, kept as read. */
  position: number;
  depth: number;
  role: NoteRole;
  whole_words: boolean;
  exclude_recursion: boolean;
  prevent_recursion: boolean;
}

/** A card as it is read on its own: with its lorebook. */
export interface CharacterWithLore extends Character {
  lore_entries: LoreEntry[];
}

/** A card of the starter library, as its file holds it. */
export interface LibraryItem {
  filename: string;
  card: unknown;
  has_avatar: boolean;
}

export interface Settings {
  global_instructions: string;
  auto_memory: boolean;
  update_check: boolean;
}

/** What only the server knows for the notice of a newer release. */
export interface Installation {
  current: string;
  /** "built": an image built from the source, which the published one would replace. */
  kind: "docker" | "built" | "clone" | "zip";
  /** Null for a copy downloaded as a ZIP or an image built from the source, which no command updates. */
  command: string | null;
}

export interface Memory {
  id: string;
  conversation_id: string;
  content: string;
  source_position: number;
  is_pinned: boolean;
  source: "auto" | "user";
  created_at: string;
}

/** Why a reply did not come, or came cut short: when a model's server failed, the message is what
 *  it said, or the address it could not be reached at. */
export interface TurnFailure {
  kind: string;
  message: string;
  resource?: string;
  /** A model server's own word for why it withheld the reply. */
  reason?: string;
}

/** What one AI, one character or one conversation has cost. `free`: it was called, never for money. */
export interface SpentTotal {
  total: number;
  currency: string;
  calls: number;
  unpriced_calls: number;
  free: boolean;
}

/** What calls to a model are for, as Spending splits them; "memory" holds the condensations too. */
export type SpendingUse = "reply" | "regenerate" | "continue" | "pen" | "memory" | "card" | "speed";

/** The money of each origin of an amount. "estimated" overlaps the others: counted from what
 *  arrived, at the price read or typed. */
export interface SpendingSources { reported: number; computed_read: number; computed_typed: number; estimated: number }

/** A long list past its 50 dearest, in one line. */
export type SpendingRest = [lines: number, cost: number, calls: number, unpriced_calls: number];

/** Sums of the calls of a period, as the server writes them: lists are rows, to stay small on a
 *  slow link. Instants are UTC; days are the device's. The filter of one AI narrows `uses`, `cards`
 *  and `conversations`, and gives `model_total`; never the rest. */
export interface Spending {
  /** Since when calls are counted: the update, or the last clear. */
  since: string;
  currency: string;
  total: number;
  model_total: number | null;
  /** The same number of days just before, with its calls that had no price; null since the
   *  start, and when those days end before counting began. */
  previous: { cost: number; unpriced_calls: number } | null;
  calls: number;
  sources: SpendingSources;
  outside_replies: { cost: number; calls: number; unpriced_calls: number; free_calls: number };
  uses: [use: SpendingUse, cost: number, calls: number, retried: number, unpriced_calls: number,
    unpriced_tokens_in: number, unpriced_tokens_out: number, free_calls: number][];
  /** A bar a day up to 31 days, a week beyond; `start` is the bar's first local day. */
  series: { step: "day" | "week"; points: [start: string, cost_replies: number, cost_other: number][] };
  /** Never a free one: those are in `free`. */
  models: [model_id: string | null, name: string | null, service_name: string | null, cost: number,
    cost_upstream: number, upstream: string | null, calls: number, replies: number, tokens_in: number,
    tokens_out: number, unpriced_calls: number, deleted: boolean][];
  free: [model_id: string | null, name: string | null, where: "pc" | "network" | "service", replies: number,
    tokens_in: number, service_name: string | null][];
  /** A null `card_id`: the drafts of cards not saved yet, "New card". */
  cards: [card_id: string | null, name: string | null, kind: Kind | null, cost: number, calls: number,
    unpriced_calls: number, unpriced_tokens_in: number, unpriced_tokens_out: number, free_only: boolean,
    deleted: boolean][];
  cards_rest: SpendingRest | null;
  conversations: [id: string, title: string | null, card_name: string | null, cost: number, calls: number,
    unpriced_calls: number, unpriced_tokens_in: number, unpriced_tokens_out: number, free_only: boolean,
    deleted: boolean][];
  conversations_rest: SpendingRest | null;
  unpriced: { calls: number; tokens_in: number; tokens_out: number };
}

/** What a hundred replies of an AI cost, from its last ones (at most 100, at least 20). */
export interface Per100 { cost: number; n: number; typed: boolean }

/** [model_id, name, cost, calls, unpriced_calls, free] */
export type SpendingModelLine = [model_id: string | null, name: string | null, cost: number, calls: number,
  unpriced_calls: number, free: boolean];

/** The detail of one line of Spending opened, by what it is a line of. */
export interface SpendingDetailOfModel {
  name: string | null;
  service_name: string | null;
  deleted: boolean;
  /** The AI exists and has no whole price: one can be typed. */
  priceable: boolean;
  per100: Per100 | null;
  cost: number;
  cost_upstream: number;
  upstream: string | null;
  calls: number;
  unpriced_calls: number;
  tokens: { in: number; out: number; cached: number; reasoning: number };
  sources: SpendingSources;
  /** A computed amount read from the cache with no price for it: at most this much. */
  at_most: boolean;
  uses: [use: SpendingUse, cost: number, calls: number, retried: number, unpriced_calls: number][];
  cards: [card_id: string | null, name: string | null, kind: Kind | null, cost: number, calls: number,
    deleted: boolean][];
  cards_rest: SpendingRest | null;
}

export interface SpendingDetailOfCard {
  name: string | null;
  kind: Kind | null;
  deleted: boolean;
  cost: number;
  calls: number;
  unpriced_calls: number;
  models: SpendingModelLine[];
  conversations: [id: string, title: string | null, cost: number, calls: number, unpriced_calls: number,
    deleted: boolean][];
}

export interface SpendingDetailOfConversation {
  title: string | null;
  card_name: string | null;
  deleted: boolean;
  cost: number;
  calls: number;
  unpriced_calls: number;
  models: SpendingModelLine[];
  uses: [use: SpendingUse, cost: number, calls: number, retried: number, unpriced_calls: number][];
  /** What a reply cost in the first tenth and in the last; null under 10 such replies. */
  growth: { first: number; last: number } | null;
}

export interface SpendingDetailOfUse {
  use: SpendingUse;
  cost: number;
  calls: number;
  retried: number;
  unpriced_calls: number;
  unpriced_tokens_in: number;
  unpriced_tokens_out: number;
  models: SpendingModelLine[];
}

export type SpendingDetail =
  | SpendingDetailOfModel | SpendingDetailOfCard | SpendingDetailOfConversation | SpendingDetailOfUse;

/** What the server says of a conversation's turn: the message being written, as far as it has
 *  got, or how the last one ended when it failed or added nothing; first, its messages' revision.
 *  Once it has ended, what the page would read next, while the story is the one it was read on:
 *  what the AI reads of it under its way, and what the conversation has cost. */
export type TurnState = { revision: number | null } & (
  | { running: true; message_id: string; text: string }
  | {
      running: false;
      outcome: (TurnFailure & { mode: "send" | "regenerate" | "continue" }) | null;
      glance?: Outlook["current"] | null;
      spent?: SpentTotal | null;
    });

/** What following a turn hands over: the message so far, then each piece as it arrives. */
export type TurnEvent = { text: string } | { delta: string } | { end: true };
