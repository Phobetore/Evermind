export type Kind = "character" | "scenario";
export type ProviderType = "openai-compatible" | "anthropic";
export type NoteRole = "system" | "user" | "assistant";

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
  is_favorite: boolean;
  created_at: string;
  updated_at: string;
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

export interface Connection {
  id: string;
  name: string;
  provider: ProviderType;
  base_url: string;
  model: string;
  context_size: number;
  /** Null leaves a setting to the model: it is not sent. */
  max_tokens: number | null;
  temperature: number | null;
  top_p: number | null;
  frequency_penalty: number | null;
  presence_penalty: number | null;
  is_default: boolean;
  api_key_set: boolean;
  api_key_hint: string;
  created_at: string;
  updated_at: string;
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

export interface Conversation {
  id: string;
  character_id: string;
  persona_id: string | null;
  connection_id: string | null;
  title: string;
  summary: string;
  author_note?: string;
  /** Why the last automatic pass of the memory failed, until one succeeds. */
  memory_error?: { error: string; kind?: string } | null;
  /** Whether a memory pass or a consolidation is under way. */
  memory_running?: boolean;
  wallpaper_url?: string | null;
  wallpaper_opacity?: number;
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
  reply_length: "short" | "medium" | "long";
  history_limit: number;
  passage_budget: number;
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
}

/** What the server says of a conversation's turn: the message being written, as far as it has
 *  got, or how the last one ended when it failed or added nothing; first, its messages' revision. */
export type TurnState = { revision: number | null } & (
  | { running: true; message_id: string; text: string }
  | { running: false; outcome: (TurnFailure & { mode: "send" | "regenerate" | "continue" }) | null });

/** What following a turn hands over: the message so far, then each piece as it arrives. */
export type TurnEvent = { text: string } | { delta: string } | { end: true };
