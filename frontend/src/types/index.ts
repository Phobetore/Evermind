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
  limits_read_at: string | null;
  reply_cap: { mode: "auto" | "unsent" | "fixed"; tokens: number | null };
  /** Null leaves a setting to the model: it is not sent. */
  temperature: number | null;
  top_p: number | null;
  frequency_penalty: number | null;
  presence_penalty: number | null;
  /** Made from a connection by the update to AIs. */
  migrated: boolean;
  notices: ("follow_server" | "let_evermind")[];
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

/** What the server says of a conversation's turn: the message being written, as far as it has
 *  got, or how the last one ended when it failed or added nothing; first, its messages' revision. */
export type TurnState = { revision: number | null } & (
  | { running: true; message_id: string; text: string }
  | { running: false; outcome: (TurnFailure & { mode: "send" | "regenerate" | "continue" }) | null });

/** What following a turn hands over: the message so far, then each piece as it arrives. */
export type TurnEvent = { text: string } | { delta: string } | { end: true };
