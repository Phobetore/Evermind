export type Kind = "character" | "scenario";
export type ProviderType = "openai-compatible" | "anthropic";

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
  memory_error?: {
    error: string;
    kind?: string;
    upstream?: string;
    upstream_status?: number;
    upstream_url?: string;
  } | null;
  wallpaper_url?: string | null;
  wallpaper_opacity?: number;
  forked_from?: string | null;
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
  /** Null for a copy downloaded as a ZIP, which no command updates. */
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

/** Why a reply did not come, or came cut short: what a model's server said, when it was the one
 *  that failed, or the address that could not be reached. */
export interface TurnFailure {
  kind: string;
  message: string;
  resource?: string;
  upstream?: string;
  upstream_status?: number;
  upstream_url?: string;
}

/** What the server says of a conversation's turn: the message being written, as far as it has
 *  got, or how the last one ended when it failed or added nothing ("nothing_added"). */
export type TurnState =
  | { running: true; message_id: string; text: string }
  | { running: false; outcome: (TurnFailure & { mode: "send" | "regenerate" | "continue" }) | null };

/** What following a turn hands over: the message so far, then each piece as it arrives. */
export type TurnEvent = { text: string } | { delta: string } | { end: true };
