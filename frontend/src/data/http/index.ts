import type {
  Character, CharacterWithLore, Connection, Conversation, Installation, LibraryItem, Memory,
  Message, Persona, Settings, TurnState,
} from "@/types";
import type {
  BenchmarkResult, ConnectionTestResult, ConsolidateResult, DataSource, ExtractResult,
} from "../source";
import { readEvents } from "./events";
import { lazyFetch, request, send } from "./request";

/** Path segments are whatever the caller passed in, so each one is encoded:
 *  an id with a slash or a question mark in it must not reach another route. */
const seg = encodeURIComponent;

/** `?a=1&b=2` for the values that are set, and nothing at all when none is. */
function queryString(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/** The self-hosted edition: the interface and the server share an origin, and
 *  every call is a request to `api/...`. That is written without a leading
 *  slash on purpose: it resolves against the page, whose address is always the
 *  root of the app (its routes live after the "#"), so Evermind works as well
 *  under a path such as `/evermind/` as at the root of a host. `fetchImpl` is
 *  there for tests. */
export function createHttpSource(fetchImpl: typeof fetch = lazyFetch): DataSource {
  const call = <T>(path: string, init?: RequestInit) => request<T>(path, init, fetchImpl);
  const get = <T>(path: string) => call<T>(path);
  const post = <T = void>(path: string, body?: unknown) =>
    call<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
  const put = <T>(path: string, body: unknown) =>
    call<T>(path, { method: "PUT", body: JSON.stringify(body) });
  const patch = <T>(path: string, body: unknown) =>
    call<T>(path, { method: "PATCH", body: JSON.stringify(body) });
  const del = <T = void>(path: string) => call<T>(path, { method: "DELETE" });
  const upload = <T>(path: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return call<T>(path, { method: "POST", body: form });
  };

  return {
    edition: "self-hosted",

    characters: {
      list: (query) =>
        get<Character[]>(`api/characters${queryString({ kind: query?.kind, q: query?.q?.trim() })}`),
      get: (id) => get<CharacterWithLore>(`api/characters/${seg(id)}`),
      create: (input) => post<Character>("api/characters", input),
      update: (id, input) => put<Character>(`api/characters/${seg(id)}`, input),
      remove: (id) => del(`api/characters/${seg(id)}`),
      uploadAvatar: (id, file) => upload<Character>(`api/characters/${seg(id)}/avatar`, file),
      assist: (input) => post("api/characters/assist", input),
    },

    personas: {
      list: () => get<Persona[]>("api/personas"),
      create: (input) => post<Persona>("api/personas", input),
      update: (id, input) => put<Persona>(`api/personas/${seg(id)}`, input),
      remove: (id) => del(`api/personas/${seg(id)}`),
      uploadAvatar: (id, file) => upload<Persona>(`api/personas/${seg(id)}/avatar`, file),
    },

    conversations: {
      list: (query) =>
        get<Conversation[]>(`api/conversations${queryString({ character_id: query?.character_id })}`),
      get: (id) => get<Conversation>(`api/conversations/${seg(id)}`),
      create: (input) => post<Conversation>("api/conversations", input),
      update: (id, changes) => patch<Conversation>(`api/conversations/${seg(id)}`, changes),
      remove: (id) => del(`api/conversations/${seg(id)}`),
      setWallpaper: (id, file) =>
        upload<Conversation>(`api/conversations/${seg(id)}/wallpaper`, file),
      clearWallpaper: (id) => del<Conversation>(`api/conversations/${seg(id)}/wallpaper`),
    },

    messages: {
      update: (id, changes) => patch<Message>(`api/messages/${seg(id)}`, changes),
      branch: (id) => post<Conversation>(`api/messages/${seg(id)}/branch`),
      removeFrom: (id) => del(`api/messages/${seg(id)}`),
    },

    memories: {
      list: (conversationId) =>
        get<Memory[]>(`api/conversations/${seg(conversationId)}/memories`),
      create: (conversationId, input) =>
        post<Memory>(`api/conversations/${seg(conversationId)}/memories`, input),
      update: (id, changes) => patch<Memory>(`api/memories/${seg(id)}`, changes),
      remove: (id) => del(`api/memories/${seg(id)}`),
      extract: (conversationId) =>
        post<ExtractResult>(`api/conversations/${seg(conversationId)}/memories/extract`),
      consolidate: (conversationId) =>
        post<ConsolidateResult>(`api/conversations/${seg(conversationId)}/memories/consolidate`),
    },

    turns: {
      start: (turn) => post<{ user_message: Message | null }>("api/chat", turn),
      follow: (conversationId, onEvent, signal) =>
        readEvents(
          send(`api/conversations/${seg(conversationId)}/turn/stream`, { signal }, fetchImpl),
          onEvent,
        ),
      stop: (conversationId) => del(`api/conversations/${seg(conversationId)}/turn`),
      state: (conversationId) =>
        get<TurnState>(`api/conversations/${seg(conversationId)}/turn`),
      impersonate: (conversationId) =>
        post<{ text: string }>(`api/conversations/${seg(conversationId)}/impersonate`),
    },

    library: {
      list: () => get<LibraryItem[]>("api/library"),
      avatarUrl: (filename) => `api/library/${seg(filename)}/avatar`,
    },

    settings: {
      get: () => get<Settings>("api/settings"),
      update: (input) => put<Settings>("api/settings", input),
    },

    async file(url) {
      const blob = await (await send(url, undefined, fetchImpl)).blob();
      return new File([blob], "image", { type: blob.type });
    },

    connections: {
      list: () => get<Connection[]>("api/connections"),
      create: (input) => post<Connection>("api/connections", input),
      update: (id, input) => put<Connection>(`api/connections/${seg(id)}`, input),
      remove: (id) => del(`api/connections/${seg(id)}`),
      test: (input) => post<ConnectionTestResult>("api/connections/test", input),
      benchmark: (input) => post<BenchmarkResult>("api/connections/benchmark", input),
    },

    updates: {
      get: () => get<Installation>("api/update"),
    },

    access: {
      status: () => get<{ enabled: boolean; authenticated: boolean }>("api/gate"),
      login: (password) => post("api/gate", { password }),
      logout: () => del("api/gate"),
      logoutEverywhere: () => del("api/gate/sessions"),
    },
  };
}
