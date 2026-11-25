import type { Ai, Backdrop, Character, Family, Kind, LoreEntry, Memory, ProbeModel, ProviderType } from "@/types";

/** Given up on with `signal`, or as unanswered when no answer has begun within `within` ms. */
export interface Asking {
  signal?: AbortSignal;
  within?: number;
}

/** A card as the editor holds it: every field a person fills in, and none that
 *  the server assigns. */
export type CharacterInput = Omit<
  Character,
  "id" | "avatar_url" | "avatar_thumb_url" | "avatar_backdrop_url" | "is_favorite" | "created_at"
  | "updated_at" | "has_card"
>;

/** Two smaller copies of a portrait, and the portrait they were made from (its avatar_url). */
export interface PortraitSizes { from: string; grid: Blob; backdrop: Blob }

/** What a person asks for with "write this card for me", together with
 *  whatever is already filled in so the draft builds on it. `existing` holds
 *  card fields, plus `lore_entries` when the book has some. */
export interface AssistInput {
  prompt: string;
  kind: Kind;
  existing: Record<string, unknown>;
  /** Null: the default AI. */
  model_id: string | null;
}

/** A draft: any of the card's fields, and lorebook entries to add to it. */
export type AssistResult = Partial<CharacterInput> & {
  lore_entries?: { keys: string[]; content: string }[];
};

/** The fields of a card that the assistant writes, by the names the server gives them. */
export type AssistField =
  | "name" | "tagline" | "description" | "personality" | "scenario" | "greeting"
  | "alternate_greetings" | "example_dialogues" | "tags" | "lore_entries";

/** A card job as the server stands on it: how far the model has got while it runs, what to put in
 *  the form once it has ended. `error` can come with a `draft`: a connection that broke half-way. */
export interface AssistState {
  id: string;
  running: boolean;
  /** Since the job began, to a tenth; it stops counting when the job ends. */
  seconds: number;
  /** Characters of reasoning produced so far, 0 for a model that shows none. */
  thought: number;
  /** Characters of answer received so far. */
  written: number;
  /** The fields complete so far, in the order the model wrote them. */
  fields: AssistField[];
  /** Lorebook entries complete so far, even while the list is still being written. */
  lore: number;
  /** The field being written at this moment, if it is one. */
  writing: AssistField | null;
  /** From the end of the job: the card to put in the form, with only the fields obtained. */
  draft: AssistResult | null;
  /** The fields asked for that are not in `draft`. */
  missing: AssistField[];
  /** The model stopped for lack of room. */
  cut: boolean;
  /** Someone stopped the job. */
  stopped: boolean;
  error: { error: string; kind: string; reason?: string } | null;
}

export type LoreEntryInput = Omit<LoreEntry, "id">;

/** A character and its whole lorebook, as a card gives them (moved here from lib/cards, which re-exports it). */
export type CardCharacter = CharacterInput & { lore_entries: LoreEntryInput[] };

/** A card's file text; other_text is the PNG's second card chunk when it reads differently. */
export interface CardText {
  text: string;
  format: "png" | "json";
  other_text: string | null;
}

/** What is sent to keep a card: its text, and what the reader made of it. */
export interface OriginalCard extends CardText {
  read: CardCharacter;
}

/** What the server kept: `read` as it stored it, entries it does not keep left out. */
export interface StoredCard extends OriginalCard {
  read_at: string;
}

export interface PersonaInput {
  name: string;
  description: string;
  is_default: boolean;
}

export interface ConversationInput {
  character_id: string;
  persona_id: string | null;
  /** Null: the default AI of this moment, which the conversation then keeps. */
  model_id: string | null;
  /** Asked for again under the same one, it is the conversation made the first time. */
  client_id?: string;
}

export interface ConversationPatch {
  title?: string;
  summary?: string;
  /** The summary the new one was typed over. */
  summary_was?: string;
  author_note?: string;
  model_id?: string;
  /** The line saying an AI was removed has been seen. */
  model_lost_seen?: true;
  wallpaper_opacity?: number;
  backdrop?: Backdrop;
  backdrop_strength?: number | null;
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

/** A saved service, named by its id. `family`: the chip it was reached by. */
export interface SavedRef { id: string; family?: Family }

/** A service as the page holds it before it is saved, or a saved one edited (`id`). With no key
 *  (undefined or null), the saved one's is used, and only at the address it was given for; "" is
 *  no key. */
export interface ServiceDraft {
  id?: string;
  name?: string;
  provider: ProviderType;
  base_url: string;
  api_key?: string | null;
  family?: Family;
}

/** What a service's PUT takes, exactly: anything else is refused by the server. */
export interface ServiceUpdate {
  name?: string;
  provider?: ProviderType;
  base_url?: string;
  /** null keeps the key, "" clears it. */
  api_key?: string | null;
}

/** The AIs to add on one service, in one write. `read`: the model as the probe relayed it. */
export interface ModelsCreate {
  service: SavedRef | ServiceDraft;
  models: {
    model: string;
    name?: string;
    context_own?: number | null;
    price_own_in?: number | null;
    price_own_out?: number | null;
    read?: ProbeModel;
  }[];
  /** The conversation that asked: it is given the last AI of the list. */
  conversation_id?: string;
}

/** What an AI's PUT takes; each field left out stays as it is. */
export interface ModelUpdate {
  name?: string;
  model?: string;
  /** Only true: another is made the default by marking it. */
  is_default?: true;
  /** null follows what the server says. */
  context_own?: number | null;
  reply_cap?: { mode: "auto" | "unsent" | "fixed"; tokens?: number | null };
  temperature?: number | null;
  top_p?: number | null;
  frequency_penalty?: number | null;
  presence_penalty?: number | null;
  price_own_in?: number | null;
  price_own_out?: number | null;
  notices_kept?: boolean;
}

/** An AI as saved, with what the person typed that the server says is too much. */
export type AiSaved = Ai & { warnings: ("above_read_window" | "above_read_output" | "cap_above_window")[] };

export interface BenchmarkResult {
  ok: boolean;
  detail?: string;
  tokens_per_s?: number;
  first_token_seconds?: number;
}
