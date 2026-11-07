import type {
  Character, Connection, Conversation, LibraryItem, LoreEntry, Memory, Message, Persona,
  Settings, TurnState, UpdateStatus,
} from "@/types";
import type {
  BenchmarkResult, ConnectionTestResult, ConsolidateResult, DataSource, ExtractResult,
} from "../source";
import { readEvents } from "./events";
import { characterOf, conversationOf, personaOf } from "./media";
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

/** The name the server gave the download, which is the card's own name with
 *  the characters a file name cannot carry taken out. `filename*` carries it in
 *  UTF-8 and is preferred; `filename` is the ASCII fallback, which for a name in
 *  another script is only a generic one. */
function downloadName(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const encoded = /filename\*\s*=\s*utf-8'[^']*'([^;]+)/i.exec(disposition);
  if (encoded) {
    try {
      const name = decodeURIComponent(encoded[1].trim());
      if (name) return name;
    } catch {
      // A broken percent escape: the plain name below is still good.
    }
  }
  const match = /filename="([^"]*)"|filename=([^;]+)/i.exec(disposition);
  return (match && (match[1] ?? match[2])?.trim()) || undefined;
}

/** The self-hosted edition: the interface and the server share an origin, and
 *  every call is a request to `api/...`. That is written without a leading
 *  slash on purpose: it resolves against the page, whose address is always the
 *  root of the app (its routes live after the "#"), so Evermind works as well
 *  under a path such as `/evermind/` as at the root of a host. The addresses of
 *  images that the server writes are made relative here too. `fetchImpl` is
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
        get<Character[]>(`api/characters${queryString({ kind: query?.kind, q: query?.q?.trim() })}`)
          .then((list) => list.map(characterOf)),
      get: (id) => get<Character>(`api/characters/${seg(id)}`).then(characterOf),
      create: (input) => post<Character>("api/characters", input).then(characterOf),
      update: (id, input) =>
        put<Character>(`api/characters/${seg(id)}`, input).then(characterOf),
      remove: (id) => del(`api/characters/${seg(id)}`),
      uploadAvatar: (id, file) =>
        upload<Character>(`api/characters/${seg(id)}/avatar`, file).then(characterOf),
      importCard: (file) => upload<Character>("api/characters/import", file).then(characterOf),
      async exportCard(id, format) {
        const resp = await send(
          `api/characters/${seg(id)}/export${queryString({ format })}`, undefined, fetchImpl,
        );
        return {
          blob: await resp.blob(),
          filename: downloadName(resp.headers.get("Content-Disposition")) ?? `card.${format}`,
        };
      },
      assist: (input) => post("api/characters/assist", input),
    },

    lore: {
      list: (characterId) => get<LoreEntry[]>(`api/characters/${seg(characterId)}/lore`),
      create: (characterId, input) =>
        post<LoreEntry>(`api/characters/${seg(characterId)}/lore`, input),
      update: (id, changes) => patch<LoreEntry>(`api/lore/${seg(id)}`, changes),
      remove: (id) => del(`api/lore/${seg(id)}`),
    },

    personas: {
      list: () => get<Persona[]>("api/personas").then((list) => list.map(personaOf)),
      create: (input) => post<Persona>("api/personas", input).then(personaOf),
      update: (id, input) => put<Persona>(`api/personas/${seg(id)}`, input).then(personaOf),
      remove: (id) => del(`api/personas/${seg(id)}`),
      uploadAvatar: (id, file) =>
        upload<Persona>(`api/personas/${seg(id)}/avatar`, file).then(personaOf),
    },

    conversations: {
      list: (query) =>
        get<Conversation[]>(`api/conversations${queryString({ character_id: query?.character_id })}`)
          .then((list) => list.map(conversationOf)),
      get: (id) => get<Conversation>(`api/conversations/${seg(id)}`).then(conversationOf),
      create: (input) => post<Conversation>("api/conversations", input).then(conversationOf),
      update: (id, changes) =>
        patch<Conversation>(`api/conversations/${seg(id)}`, changes).then(conversationOf),
      remove: (id) => del(`api/conversations/${seg(id)}`),
      setWallpaper: (id, file) =>
        upload<Conversation>(`api/conversations/${seg(id)}/wallpaper`, file).then(conversationOf),
      clearWallpaper: (id) =>
        del<Conversation>(`api/conversations/${seg(id)}/wallpaper`).then(conversationOf),
    },

    messages: {
      update: (id, changes) => patch<Message>(`api/messages/${seg(id)}`, changes),
      branch: (id) => post<Conversation>(`api/messages/${seg(id)}/branch`).then(conversationOf),
      removeFrom: (id) => del(`api/messages/${seg(id)}?following=true`),
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
      send: (turn, onEvent, signal) =>
        readEvents(
          send("api/chat", { method: "POST", body: JSON.stringify(turn), signal }, fetchImpl),
          onEvent,
        ),
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
      install: (filename) =>
        post<Character>(`api/library/${seg(filename)}/install`).then(characterOf),
      avatarUrl: (filename) => `api/library/${seg(filename)}/avatar`,
    },

    settings: {
      get: () => get<Settings>("api/settings"),
      update: (input) => put<Settings>("api/settings", input),
    },

    connections: {
      list: () => get<Connection[]>("api/connections"),
      create: (input) => post<Connection>("api/connections", input),
      update: (id, input) => put<Connection>(`api/connections/${seg(id)}`, input),
      remove: (id) => del(`api/connections/${seg(id)}`),
      test: (input) => post<ConnectionTestResult>("api/connections/test", input),
      testSaved: (id) => post<ConnectionTestResult>(`api/connections/${seg(id)}/test`),
      benchmark: (id) => post<BenchmarkResult>(`api/connections/${seg(id)}/benchmark`),
    },

    updates: {
      check: (refresh) => get<UpdateStatus>(`api/update${refresh ? "?refresh=true" : ""}`),
    },

    access: {
      status: () => get<{ enabled: boolean; authenticated: boolean }>("api/gate"),
      login: (password) => post("api/gate", { password }),
      logout: () => del("api/gate"),
      logoutEverywhere: () => del("api/gate/sessions"),
    },
  };
}
