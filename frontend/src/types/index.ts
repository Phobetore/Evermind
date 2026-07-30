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
  max_tokens: number;
  temperature: number;
  top_p: number;
  frequency_penalty: number;
  presence_penalty: number;
  extra_params: Record<string, unknown>;
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
  forked_from?: string | null;
  forked_at_position?: number | null;
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

/** A lorebook entry as edited in the form: identical for a saved entry and for
    one being drafted before the character exists (temporary client-side id). */
export interface LoreEntryDraft {
  id: string;
  keys: string[];
  content: string;
  enabled: boolean;
  case_sensitive: boolean;
  priority: number;
}

export interface LoreEntry extends LoreEntryDraft {
  character_id: string;
  created_at: string;
  updated_at: string;
}

export interface LibraryItem {
  filename: string;
  name: string;
  kind: Kind;
  tagline: string;
  tags: string[];
  creator_notes: string;
  has_lorebook: boolean;
  has_avatar: boolean;
  installed: boolean;
}

export interface Settings {
  default_connection_id: string | null;
  default_persona_id: string | null;
  global_instructions: string;
  auto_memory: boolean;
  reply_length: "short" | "medium" | "long";
  history_limit: number;
  passage_budget: number;
}

export interface Memory {
  id: string;
  conversation_id: string;
  kind: "fact" | "event" | "relationship" | "promise" | "state";
  content: string;
  source_position: number;
  is_pinned: boolean;
  source: "auto" | "user";
  created_at: string;
}

export type ChatEvent =
  | { type: "start"; conversation_id: string; user_message: Message | null }
  | { type: "delta"; text: string }
  | { type: "done"; message: Message; context?: ContextStats; perf?: TurnPerf }
  | { type: "error"; message: string };
