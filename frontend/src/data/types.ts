import type { Character, Kind, LoreEntry, Memory, ProviderType } from "@/types";

/** Given up on with `signal`, or as unanswered when no answer has begun within `within` ms. */
export interface Asking {
  signal?: AbortSignal;
  within?: number;
}

/** A card as the editor holds it: every field a person fills in, and none that
 *  the server assigns. */
export type CharacterInput = Omit<
  Character,
  "id" | "avatar_url" | "is_favorite" | "created_at" | "updated_at"
>;

/** What a person asks for with "write this card for me", together with
 *  whatever is already filled in so the draft builds on it. `existing` holds
 *  card fields, plus `lore_entries` when the book has some. */
export interface AssistInput {
  prompt: string;
  kind: Kind;
  existing: Record<string, unknown>;
  connection_id: string | null;
}

/** A draft: any of the card's fields, and lorebook entries to add to it. */
export type AssistResult = Partial<CharacterInput> & {
  lore_entries?: { keys: string[]; content: string }[];
};

export type LoreEntryInput = Omit<LoreEntry, "id">;

export interface PersonaInput {
  name: string;
  description: string;
  is_default: boolean;
}

export interface ConversationInput {
  character_id: string;
  persona_id: string | null;
  connection_id: string | null;
  /** Asked for again under the same one, it is the conversation made the first time. */
  client_id?: string;
}

export interface ConversationPatch {
  title?: string;
  summary?: string;
  /** The summary the new one was typed over. */
  summary_was?: string;
  author_note?: string;
  connection_id?: string;
  wallpaper_opacity?: number;
}

/** What "memorize now" found: the facts it added, a new summary if the
 *  conversation earned one, and the whole list as it stands afterwards. */
export interface ExtractResult {
  facts_added: Memory[];
  summary: string | null;
  memories: Memory[];
}

export interface ConsolidateResult {
  before: number;
  after: number;
  memories: Memory[];
}

export interface TurnRequest {
  conversation_id: string;
  mode: "send" | "regenerate" | "continue";
  content?: string;
  message_mode?: "say" | "narrate" | "ooc";
  /** For a message: says it is the same one, if it has to be sent again. */
  client_id?: string;
}

/** A connection as the form holds it. `api_key` is left out when editing a
 *  saved connection whose key should stay as it is: the server never sends a
 *  key back, so there is nothing to put there. */
export interface ConnectionInput {
  name: string;
  provider: ProviderType;
  base_url: string;
  api_key?: string;
  model: string;
  context_size: number;
  max_tokens: number | null;
  temperature: number | null;
  top_p: number | null;
  frequency_penalty: number | null;
  presence_penalty: number | null;
  is_default: boolean;
}

/** How a connection test or a benchmark went. One that failed is an error; the form keeps its
 *  sentence in `detail`. */
export interface ConnectionTestResult {
  ok: boolean;
  detail: string;
  model_count?: number;
  models_sample?: string[];
}

export interface BenchmarkResult {
  ok: boolean;
  detail?: string;
  tokens_per_s?: number;
  first_token_seconds?: number;
}
