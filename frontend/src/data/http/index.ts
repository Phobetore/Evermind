import type {
  Ai, Character, CharacterTile, CharacterWithLore, Conversation, Installation, LibraryItem, Memory,
  Message, Outlook, Persona, ProbeResult, Service, Settings, Spending, SpendingDetail, SpentTotal, TurnEvent,
  TurnState, WayFields, WayListed, Ways,
} from "@/types";
import type { DataSource } from "../contract";
import { device } from "./device";
import { readEvents } from "./events";
import { request, send } from "./request";
import { zoneOfDevice } from "./zone";
import type {
  AiSaved, Asking, AssistInput, AssistState, BenchmarkResult, CharacterInput, ConsolidateResult,
  ConversationInput, ConversationPatch, Cut, ExtractResult, LoreEntryInput, ModelsCreate, ModelUpdate,
  OriginalCard, PersonaInput, PortraitSizes, SavedRef, ServiceDraft, ServiceUpdate, SpendingQuery, StoredCard,
  TurnRequest,
} from "../types";
import { DataError } from "../errors";

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
/** `?forget_name=1` only when asked: a deletion that keeps the name sends what it always sent. */
const forgetting = (options?: { forgetName?: boolean }) => (options?.forgetName ? "?forget_name=1" : "");

/** A query of Spending: the values set, in their order, then the device's zone, which turns its
 *  days into instants on the server. */
function inZone(values: Record<string, string | number | undefined>): string {
  const { tz, tzo } = zoneOfDevice();
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) if (value !== undefined) query.set(name, String(value));
  if (tz) query.set("tz", tz);
  query.set("tzo", String(tzo));
  return query.toString();
}

/** The name the server gave a file it sends, or one of ours. */
function filenameOf(resp: Response, fallback: string): string {
  const said = /filename="([^"]+)"/.exec(resp.headers.get("Content-Disposition") ?? "");
  return said?.[1] ?? fallback;
}

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
    tiles: () => get<CharacterTile[]>("api/characters?fields=card"),
    search: (text: string, asking?: Asking) => fresh<string[]>(`api/characters/search?q=${seg(text)}`, asking),
    get: (id: string) => get<CharacterWithLore>(`api/characters/${seg(id)}`),
    /** `lore_entries` is the whole lorebook: an entry with no keyword or no text is left out. */
    create: (input: CharacterInput & { lore_entries?: LoreEntryInput[]; card?: OriginalCard; assist_jobs?: string[] }) =>
      post<Character>("api/characters", input),
    update: (
      id: string,
      input: Partial<CharacterInput> & { is_favorite?: boolean; lore_entries?: LoreEntryInput[]; card?: OriginalCard },
    ) => put<Character>(`api/characters/${seg(id)}`, input),
    card: (id: string) => get<StoredCard | null>(`api/characters/${seg(id)}/card`),
    remove: (id: string, options?: { forgetName?: boolean }) =>
      del(`api/characters/${seg(id)}${forgetting(options)}`),
    uploadAvatar: (id: string, file: File) => upload<Character>(`api/characters/${seg(id)}/avatar`, file),
    /** A portrait replaced meanwhile answers 409: no failure, only copies that are not wanted any more. */
    async saveSizes(id: string, sizes: PortraitSizes, asking?: Asking) {
      const form = new FormData();
      form.append("portrait", sizes.from.slice(sizes.from.lastIndexOf("/") + 1));
      const named = (name: string, blob: Blob) =>
        form.append(name, blob, `${name}.${blob.type === "image/webp" ? "webp" : "jpg"}`);
      named("grid", sizes.grid);
      named("backdrop", sizes.backdrop);
      try {
        return await request<Character>(`api/characters/${seg(id)}/avatar/sizes`, { method: "POST", body: form }, asking);
      } catch (error) {
        if (error instanceof DataError && error.kind === "portrait_changed") return null;
        throw error;
      }
    },
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
    update: (id: string, changes: ConversationPatch, options?: { outlivePage?: boolean }) =>
      request<Conversation>(`api/conversations/${seg(id)}`, {
        method: "PATCH",
        body: JSON.stringify(changes),
        // A few dozen bytes, far under the 64 KB a request kept past its page may carry.
        ...(options?.outlivePage ? { keepalive: true } : {}),
      }),
    remove: (id: string, options?: { forgetName?: boolean }) =>
      del(`api/conversations/${seg(id)}${forgetting(options)}`),
    setWallpaper: (id: string, file: File) =>
      upload<Conversation>(`api/conversations/${seg(id)}/wallpaper`, file),
    clearWallpaper: (id: string) => del<Conversation>(`api/conversations/${seg(id)}/wallpaper`),
    // Past the cache: it changes with every message, and with a way changed on another device.
    outlook: (id: string, options?: { only?: "current" }) =>
      fresh<Outlook>(`api/conversations/${seg(id)}/outlook` + (options?.only ? `?only=${seg(options.only)}` : "")),
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

  ways: {
    list: () => get<Ways>("api/ways"),
    update: (id: string, changes: Partial<WayFields> & { name?: string }) => put<WayListed>(`api/ways/${seg(id)}`, changes),
    copy: (from: string, name: string) => post<WayListed>("api/ways", { from, name }),
    remove: (id: string) => del<{ moved: number; to: string }>(`api/ways/${seg(id)}`),
    reset: (id: string) => post<WayListed>(`api/ways/${seg(id)}/reset`),
    setDefault: (id: string) => put<Ways>("api/ways/default", { id }),
  },

  /** An image the server serves, such as a portrait, as a file to draw or to send back. */
  async file(url: string, asking?: Asking) {
    // The same signal cuts the reading of the body: a fetch aborted after its headers stops there too.
    const blob = await (await send(url, {}, asking)).blob();
    return new File([blob], "image", { type: blob.type });
  },

  device,

  // The browser loads an image of another site itself: nothing between it and the site blocks one.
  remoteImages: true,

  connections: {
    services: {
      list: () => get<Service[]>("api/connections"),
      update: (id: string, input: ServiceUpdate) => put<Service>(`api/connections/${seg(id)}`, input),
      remove: (id: string) => del(`api/connections/${seg(id)}`),
    },
    models: {
      list: () => get<Ai[]>("api/models"),
      create: (input: ModelsCreate) =>
        post<{ service: Service; models: Ai[]; conversation: Conversation | null }>("api/models", input),
      update: (id: string, input: ModelUpdate) => put<AiSaved>(`api/models/${seg(id)}`, input),
      remove: (id: string) => del(`api/models/${seg(id)}`),
      refresh: (id: string, options: { fresh?: boolean } = {}) =>
        post<{ model: Ai; read_ok: boolean; error: { kind: string; message: string } | null }>(
          `api/models/${seg(id)}/refresh`, { fresh: options.fresh ?? false }),
      benchmark: (id: string) => post<BenchmarkResult>(`api/models/${seg(id)}/benchmark`),
      observed: (id: string, tokens: number) => post<AiSaved>(`api/models/${seg(id)}/observed`, { tokens }),
    },
    // Saves nothing; a list of hundreds of models on a slow link, which "Cancel" gives up on.
    probe: (ref: SavedRef | ServiceDraft, options: { fresh?: boolean; asking?: Asking } = {}) =>
      request<ProbeResult>("api/connections/probe", {
        method: "POST", body: JSON.stringify({ ...ref, fresh: options.fresh ?? false }),
      }, options.asking),
  },

  updates: {
    get: () => get<Installation>("api/update"),
  },

  // Past the cache: every reply changes them.
  spending: {
    summary: (q: SpendingQuery, asking?: Asking) =>
      fresh<Spending>(`api/spending?${inZone({ from: q.from, to: q.to, model: q.model })}`, asking),
    detail: (q: SpendingQuery & { cut: Cut; key: string }, asking?: Asking) =>
      fresh<SpendingDetail>(`api/spending/detail?${inZone({ cut: q.cut, key: q.key, from: q.from, to: q.to })}`, asking),
    total: (q: { model?: string; card?: string; conversation?: string; days: 30 | "all" }) =>
      fresh<SpentTotal>(`api/spending/total?${inZone({
        model: q.model, card: q.card, conversation: q.conversation, days: q.days,
      })}`),
    async exportCsv(q: SpendingQuery) {
      const resp = await send(`api/spending/export.csv?${inZone({ from: q.from, to: q.to })}`);
      return { blob: await resp.blob(), filename: filenameOf(resp, "evermind-spending.csv") };
    },
    clear: (q: { before?: string; dryRun: boolean }) =>
      del<{ calls: number; first: string | null; last: string | null } | { deleted: number; since: string }>(
        `api/spending?${inZone({ before: q.before, dry_run: q.dryRun ? 1 : undefined })}`),
    forget: (cut: "conversation" | "card", key: string) =>
      post<{ forgotten: number }>("api/spending/forget", { cut, key }),
  },

  access: {
    status: () => get<{ enabled: boolean; authenticated: boolean }>("api/gate"),
    login: (password: string) => post("api/gate", { password }),
    logout: () => del("api/gate"),
    logoutEverywhere: () => del("api/gate/sessions"),
  },
};
