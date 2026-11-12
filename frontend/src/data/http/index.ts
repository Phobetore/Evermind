import type {
  Character, CharacterWithLore, Connection, Conversation, Installation, LibraryItem, Memory,
  Message, Persona, Settings, TurnEvent, TurnState,
} from "@/types";
import type { DataSource } from "../contract";
import { readEvents } from "./events";
import { request, send } from "./request";
import type {
  Asking, AssistInput, AssistState, BenchmarkResult, CharacterInput, ConnectionInput,
  ConnectionTestResult, ConsolidateResult, ConversationInput, ConversationPatch, ExtractResult,
  LoreEntryInput, PersonaInput, TurnRequest,
} from "../types";

export { onLocked } from "./request";

/** Path segments are whatever the caller passed in, so each one is encoded:
 *  an id with a slash or a question mark in it must not reach another route. */
const seg = encodeURIComponent;

const get = <T>(path: string) => request<T>(path);
// Past the cache, where a request to the same address left hanging would hold it.
const fresh = <T>(path: string, asking?: Asking) => request<T>(path, { cache: "no-store" }, asking);
const post = <T = void>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const put = <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
const del = <T = void>(path: string, asking?: Asking) => request<T>(path, { method: "DELETE" }, asking);
const upload = <T>(path: string, file: File) => {
  const form = new FormData();
  form.append("file", file);
  return request<T>(path, { method: "POST", body: form });
};

/** Everything the interface asks of its server. No address starts with a slash: each resolves against
 *  the page, always the root of the app (its routes live after the "#"), even under `/evermind/`. */
export const data: DataSource = {
  characters: {
    list: () => get<Character[]>("api/characters"),
    get: (id: string) => get<CharacterWithLore>(`api/characters/${seg(id)}`),
    /** `lore_entries` is the whole lorebook: an entry with no keyword or no text is left out. */
    create: (input: CharacterInput & { lore_entries?: LoreEntryInput[] }) =>
      post<Character>("api/characters", input),
    update: (
      id: string,
      input: Partial<CharacterInput> & { is_favorite?: boolean; lore_entries?: LoreEntryInput[] },
    ) => put<Character>(`api/characters/${seg(id)}`, input),
    remove: (id: string) => del(`api/characters/${seg(id)}`),
    uploadAvatar: (id: string, file: File) => upload<Character>(`api/characters/${seg(id)}/avatar`, file),
    /** The card is written by a job the server owns, which outlives the page: `start` answers at
     *  once, `state` says how far it is, `stop` ends it and keeps what was complete. Asked for again
     *  under the same `client_id`, `start` is the job begun the first time. */
    assist: {
      start: (input: AssistInput & { client_id: string }) => post<{ id: string }>("api/characters/assist", input),
      state: (id: string, asking?: Asking) => fresh<AssistState>(`api/characters/assist/${seg(id)}`, asking),
      stop: (id: string) => del<AssistState>(`api/characters/assist/${seg(id)}`),
    },
  },

  personas: {
    list: () => get<Persona[]>("api/personas"),
    create: (input: PersonaInput) => post<Persona>("api/personas", input),
    update: (id: string, input: Partial<PersonaInput>) => put<Persona>(`api/personas/${seg(id)}`, input),
    remove: (id: string) => del(`api/personas/${seg(id)}`),
    uploadAvatar: (id: string, file: File) => upload<Persona>(`api/personas/${seg(id)}/avatar`, file),
  },

  conversations: {
    list: (query?: { character_id?: string }) =>
      get<Conversation[]>(
        "api/conversations" + (query?.character_id ? `?character_id=${seg(query.character_id)}` : ""),
      ),
    get: (id: string, asking?: Asking) => fresh<Conversation>(`api/conversations/${seg(id)}`, asking),
    /** All but the messages, which make a long story megabytes, for a read of what goes with them. */
    withoutMessages: (id: string, asking?: Asking) =>
      fresh<Conversation>(`api/conversations/${seg(id)}?messages=false`, asking),
    create: (input: ConversationInput) => post<Conversation>("api/conversations", input),
    update: (id: string, changes: ConversationPatch) =>
      patch<Conversation>(`api/conversations/${seg(id)}`, changes),
    remove: (id: string) => del(`api/conversations/${seg(id)}`),
    setWallpaper: (id: string, file: File) =>
      upload<Conversation>(`api/conversations/${seg(id)}/wallpaper`, file),
    clearWallpaper: (id: string) => del<Conversation>(`api/conversations/${seg(id)}/wallpaper`),
  },

  messages: {
    /** With `content`, `active_index` names the version the words go into, which is then shown. */
    update: (id: string, changes: { content?: string; active_index?: number }) =>
      patch<Message>(`api/messages/${seg(id)}`, changes),
    /** Asked for again under the same `clientId`, it is the branch made the first time. */
    branch: (id: string, clientId?: string) =>
      post<Conversation>(`api/messages/${seg(id)}/branch`, { client_id: clientId }),
    /** The message and everything after it. */
    removeFrom: (id: string) => del(`api/messages/${seg(id)}`),
  },

  memories: {
    list: (conversationId: string) => get<Memory[]>(`api/conversations/${seg(conversationId)}/memories`),
    create: (conversationId: string, input: { content: string; is_pinned?: boolean }) =>
      post<Memory>(`api/conversations/${seg(conversationId)}/memories`, input),
    update: (id: string, changes: { content?: string; is_pinned?: boolean }) =>
      patch<Memory>(`api/memories/${seg(id)}`, changes),
    remove: (id: string) => del(`api/memories/${seg(id)}`),
    extract: (conversationId: string) =>
      post<ExtractResult>(`api/conversations/${seg(conversationId)}/memories/extract`),
    consolidate: (conversationId: string) =>
      post<ConsolidateResult>(`api/conversations/${seg(conversationId)}/memories/consolidate`),
  },

  turns: {
    /** Answers once the server has the message, with the message as it was saved. */
    start: (turn: TurnRequest) => post<{ user_message: Message | null }>("api/chat", turn),
    follow: (conversationId: string, onEvent: (event: TurnEvent) => void, signal?: AbortSignal) =>
      readEvents(send(`api/conversations/${seg(conversationId)}/turn/stream`, {}, { signal }), onEvent),
    stop: (conversationId: string, asking?: Asking) =>
      del(`api/conversations/${seg(conversationId)}/turn`, asking),
    /** The reply being written for this conversation right now, asked for from this page or
     *  from another device. */
    state: (conversationId: string, asking?: Asking) =>
      fresh<TurnState>(`api/conversations/${seg(conversationId)}/turn`, asking),
    impersonate: (conversationId: string) =>
      post<{ text: string }>(`api/conversations/${seg(conversationId)}/impersonate`),
  },

  library: {
    list: () => get<LibraryItem[]>("api/library"),
    avatarUrl: (filename: string) => `api/library/${seg(filename)}/avatar`,
  },

  settings: {
    get: () => get<Settings>("api/settings"),
    update: (input: Partial<Settings>) => put<Settings>("api/settings", input),
  },

  /** An image the server serves, such as a portrait, as a file to draw or to send back. */
  async file(url: string) {
    const blob = await (await send(url)).blob();
    return new File([blob], "image", { type: blob.type });
  },

  connections: {
    list: () => get<Connection[]>("api/connections"),
    create: (input: ConnectionInput) => post<Connection>("api/connections", input),
    update: (id: string, input: ConnectionInput) => put<Connection>(`api/connections/${seg(id)}`, input),
    remove: (id: string) => del(`api/connections/${seg(id)}`),
    // Both save nothing. With no key typed, the saved connection `id` lends its own.
    test: (input: ConnectionInput & { id?: string }) =>
      post<ConnectionTestResult>("api/connections/test", input),
    benchmark: (input: ConnectionInput & { id?: string }) =>
      post<BenchmarkResult>("api/connections/benchmark", input),
  },

  updates: {
    get: () => get<Installation>("api/update"),
  },

  access: {
    status: () => get<{ enabled: boolean; authenticated: boolean }>("api/gate"),
    login: (password: string) => post("api/gate", { password }),
    logout: () => del("api/gate"),
    logoutEverywhere: () => del("api/gate/sessions"),
  },
};
