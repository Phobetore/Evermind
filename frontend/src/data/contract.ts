import type {
  Character, CharacterWithLore, Connection, Conversation, Installation, LibraryItem, Memory,
  Message, Persona, Settings, TurnEvent, TurnState,
} from "@/types";
import type {
  Asking, AssistInput, AssistState, BenchmarkResult, CharacterInput, ConnectionInput,
  ConnectionTestResult, ConsolidateResult, ConversationInput, ConversationPatch, ExtractResult,
  LoreEntryInput, PersonaInput, TurnRequest,
} from "./types";

/** A few words kept on this device and nowhere else. It never throws: a store that cannot keep
 *  anything reads as empty, and the page goes on without what it would have held. */
export interface DeviceStore {
  /** Settled once the store can be read; the interface waits for it before it draws. */
  readonly ready: Promise<void>;
  /** The language the host suggests, when it has one. Read after `ready`. */
  readonly suggestedLocale: string | null;
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  keys(prefix: string): string[];
  /** A key changed from another window: what it held, and what it holds now. Returns the way to stop listening. */
  onChange(listener: (key: string, oldValue: string | null, newValue: string | null) => void): () => void;
}

/** Everything the interface asks of where its data lives. An edition brings one of these; the
 *  interface never learns whether it is a server across the network or something else.
 *  `connections`, `access` and `updates` are the three things an edition may not have: the
 *  interface asks before it draws any of them. */
export interface DataSource {
  characters: {
    list(): Promise<Character[]>;
    get(id: string): Promise<CharacterWithLore>;
    /** `lore_entries` is the whole lorebook: an entry with no keyword or no text is left out. */
    create(input: CharacterInput & { lore_entries?: LoreEntryInput[] }): Promise<Character>;
    update(
      id: string,
      input: Partial<CharacterInput> & { is_favorite?: boolean; lore_entries?: LoreEntryInput[] },
    ): Promise<Character>;
    remove(id: string): Promise<void>;
    uploadAvatar(id: string, file: File): Promise<Character>;
    /** The card is written by a job that outlives the page: `start` answers at once, `state` says
     *  how far it is, `stop` ends it and keeps what was complete. Asked for again under the same
     *  `client_id`, `start` is the job begun the first time. */
    assist: {
      start(input: AssistInput & { client_id: string }): Promise<{ id: string }>;
      state(id: string, asking?: Asking): Promise<AssistState>;
      stop(id: string): Promise<AssistState>;
    };
  };

  personas: {
    list(): Promise<Persona[]>;
    create(input: PersonaInput): Promise<Persona>;
    update(id: string, input: Partial<PersonaInput>): Promise<Persona>;
    remove(id: string): Promise<void>;
    uploadAvatar(id: string, file: File): Promise<Persona>;
  };

  conversations: {
    list(query?: { character_id?: string }): Promise<Conversation[]>;
    get(id: string, asking?: Asking): Promise<Conversation>;
    /** All but the messages, which make a long story megabytes, for a read of what goes with them. */
    withoutMessages(id: string, asking?: Asking): Promise<Conversation>;
    create(input: ConversationInput): Promise<Conversation>;
    update(id: string, changes: ConversationPatch): Promise<Conversation>;
    remove(id: string): Promise<void>;
    setWallpaper(id: string, file: File): Promise<Conversation>;
    clearWallpaper(id: string): Promise<Conversation>;
  };

  messages: {
    /** With `content`, `active_index` names the version the words go into, which is then shown. */
    update(id: string, changes: { content?: string; active_index?: number }): Promise<Message>;
    /** Asked for again under the same `clientId`, it is the branch made the first time. */
    branch(id: string, clientId?: string): Promise<Conversation>;
    /** The message and everything after it. */
    removeFrom(id: string): Promise<void>;
  };

  memories: {
    list(conversationId: string): Promise<Memory[]>;
    create(conversationId: string, input: { content: string; is_pinned?: boolean }): Promise<Memory>;
    update(id: string, changes: { content?: string; is_pinned?: boolean }): Promise<Memory>;
    remove(id: string): Promise<void>;
    extract(conversationId: string): Promise<ExtractResult>;
    consolidate(conversationId: string): Promise<ConsolidateResult>;
  };

  turns: {
    /** Answers once the source has the message, with the message as it was saved. */
    start(turn: TurnRequest): Promise<{ user_message: Message | null }>;
    follow(conversationId: string, onEvent: (event: TurnEvent) => void, signal?: AbortSignal): Promise<void>;
    stop(conversationId: string, asking?: Asking): Promise<void>;
    /** The reply being written for this conversation right now, asked for from this page or
     *  from another device. */
    state(conversationId: string, asking?: Asking): Promise<TurnState>;
    impersonate(conversationId: string): Promise<{ text: string }>;
  };

  library: {
    list(): Promise<LibraryItem[]>;
    /** No request: the address a starter card's portrait can be read from with `file`. */
    avatarUrl(filename: string): string;
  };

  settings: {
    get(): Promise<Settings>;
    update(input: Partial<Settings>): Promise<Settings>;
  };

  /** An image the source serves, such as a portrait, as a file to draw or to send back. */
  file(url: string): Promise<File>;

  /** What this device keeps for itself: drafts, a message on its way, the chosen language. */
  readonly device: DeviceStore;

  connections?: {
    list(): Promise<Connection[]>;
    create(input: ConnectionInput): Promise<Connection>;
    update(id: string, input: ConnectionInput): Promise<Connection>;
    remove(id: string): Promise<void>;
    // Both save nothing. With no key typed, the saved connection `id` lends its own.
    test(input: ConnectionInput & { id?: string }): Promise<ConnectionTestResult>;
    benchmark(input: ConnectionInput & { id?: string }): Promise<BenchmarkResult>;
  };

  updates?: {
    get(): Promise<Installation>;
  };

  access?: {
    status(): Promise<{ enabled: boolean; authenticated: boolean }>;
    login(password: string): Promise<void>;
    logout(): Promise<void>;
    logoutEverywhere(): Promise<void>;
  };
}
