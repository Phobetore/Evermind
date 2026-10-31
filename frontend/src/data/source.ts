import type {
  ChatEvent, Character, Connection, Conversation, Kind, LibraryItem, LoreEntry, LoreEntryDraft,
  Memory, Message, Persona, ProviderType, Settings, UpdateStatus,
} from "@/types";

/** Everything the interface asks of its server, and nothing about how the
 *  server is reached. Components talk to this and never to `fetch`, so that an
 *  edition that keeps its data elsewhere can stand in for the HTTP one. */
export interface DataSource {
  readonly edition: "self-hosted" | "anna";
  characters: {
    list(query?: { kind?: Kind; q?: string }): Promise<Character[]>;
    get(id: string): Promise<Character>;
    create(input: CharacterInput): Promise<Character>;
    update(id: string, input: Partial<CharacterInput> & { is_favorite?: boolean }): Promise<Character>;
    remove(id: string): Promise<void>;
    uploadAvatar(id: string, file: File): Promise<Character>;
    importCard(file: File): Promise<Character>;
    exportCard(id: string, format: "json" | "png"): Promise<{ blob: Blob; filename: string }>;
    assist(input: AssistInput): Promise<AssistResult>;
  };
  lore: {
    list(characterId: string): Promise<LoreEntry[]>;
    create(characterId: string, input: LoreEntryInput): Promise<LoreEntry>;
    update(id: string, patch: Partial<LoreEntryInput>): Promise<LoreEntry>;
    remove(id: string): Promise<void>;
  };
  personas: {
    list(): Promise<Persona[]>;
    create(input: PersonaInput): Promise<Persona>;
    update(id: string, input: PersonaInput): Promise<Persona>;
    remove(id: string): Promise<void>;
    uploadAvatar(id: string, file: File): Promise<Persona>;
  };
  conversations: {
    list(query?: { character_id?: string }): Promise<Conversation[]>;
    get(id: string): Promise<Conversation>;
    create(input: ConversationInput): Promise<Conversation>;
    update(id: string, patch: ConversationPatch): Promise<Conversation>;
    remove(id: string): Promise<void>;
    setWallpaper(id: string, file: File): Promise<Conversation>;
    clearWallpaper(id: string): Promise<Conversation>;
    summarize(id: string): Promise<Conversation>;
  };
  messages: {
    update(id: string, patch: { content?: string; active_index?: number }): Promise<Message>;
    branch(id: string): Promise<Conversation>;
    removeFrom(id: string): Promise<void>; // the message and everything after it
  };
  memories: {
    list(conversationId: string): Promise<Memory[]>;
    create(conversationId: string, input: { content: string; is_pinned?: boolean }): Promise<Memory>;
    update(id: string, patch: { content?: string; is_pinned?: boolean }): Promise<Memory>;
    remove(id: string): Promise<void>;
    extract(conversationId: string): Promise<ExtractResult>;
    consolidate(conversationId: string): Promise<ConsolidateResult>;
  };
  turns: {
    send(request: TurnRequest, onEvent: (event: ChatEvent) => void, signal?: AbortSignal): Promise<void>;
    follow(conversationId: string, onEvent: (event: ChatEvent) => void, signal?: AbortSignal): Promise<void>;
    stop(conversationId: string): Promise<void>;
    /** Whether a reply is being written for this conversation right now, asked
     *  for from this page or from another device. */
    state(conversationId: string): Promise<{ running: boolean }>;
    impersonate(conversationId: string): Promise<{ text: string }>;
  };
  library: {
    list(): Promise<LibraryItem[]>;
    install(filename: string): Promise<Character>;
    avatarUrl(filename: string): string;
  };
  settings: { get(): Promise<Settings>; update(input: Partial<Settings>): Promise<Settings> };
  // Self-hosted only. Absent means the edition has no such thing, and the interface hides it.
  connections?: {
    list(): Promise<Connection[]>;
    create(input: ConnectionInput): Promise<Connection>;
    update(id: string, input: ConnectionInput): Promise<Connection>;
    remove(id: string): Promise<void>;
    test(input: ConnectionInput): Promise<ConnectionTestResult>;
    testSaved(id: string): Promise<ConnectionTestResult>;
    benchmark(id: string): Promise<BenchmarkResult>;
  };
  updates?: { check(refresh?: boolean): Promise<UpdateStatus> };
  access?: {
    status(): Promise<{ enabled: boolean; authenticated: boolean }>;
    login(password: string): Promise<void>;
    logout(): Promise<void>;
    logoutEverywhere(): Promise<void>;
  };
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

export type LoreEntryInput = Omit<LoreEntryDraft, "id">;

export interface PersonaInput {
  name: string;
  description: string;
  is_default: boolean;
}

export interface ConversationInput {
  character_id: string;
  persona_id: string | null;
  connection_id: string | null;
  greeting_index: number;
}

export interface ConversationPatch {
  title?: string;
  summary?: string;
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

/** `skipped` is set, and nothing changed, when there were too few facts to be
 *  worth merging. */
export interface ConsolidateResult {
  before: number;
  after: number;
  memories: Memory[];
  skipped?: string;
}

export interface TurnRequest {
  conversation_id: string;
  mode: "send" | "regenerate" | "continue";
  content?: string;
  message_mode?: "say" | "narrate" | "ooc";
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
  max_tokens: number;
  temperature: number;
  top_p: number;
  frequency_penalty: number;
  presence_penalty: number;
  is_default: boolean;
}

/** How a connection test or a benchmark went. When it failed, `detail` is the
 *  English sentence and `kind` (with what the model's server said, if it said
 *  anything) is what to describe it by. */
export interface ConnectionTestResult {
  ok: boolean;
  detail: string;
  kind?: string;
  upstream?: string;
  upstream_status?: number;
  model_count?: number;
  models_sample?: string[];
}

export interface BenchmarkResult {
  ok: boolean;
  detail?: string;
  kind?: string;
  upstream?: string;
  upstream_status?: number;
  tokens_per_s?: number;
  first_token_seconds?: number;
}
