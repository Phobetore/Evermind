import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { data, DataError as ExportedDataError, onLocked as exportedOnLocked } from "@/data";
import type { TurnEvent } from "@/types";
import { DataError } from "../errors";
import type { DataSource } from "../source";
import { createHttpSource } from "./index";
import { onLocked, request, send } from "./request";

interface Call {
  url: string;
  init: RequestInit;
}

let calls: Call[];
let replies: Response[];
let http: Required<DataSource>;

/** A JSON reply built by hand, the way the server would send it. */
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** The next call to the fake `fetch` answers with this. Unscripted calls get an
 *  empty object, which is enough for tests that only look at what was asked. */
function reply(response: Response) {
  replies.push(response);
}

/** A body that arrives in the given pieces, to put chunk boundaries where the
 *  test wants them. */
function chunked(...pieces: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const piece of pieces) controller.enqueue(encoder.encode(piece));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

/** The same, in bytes, to cut a character in two. */
function chunkedBytes(...pieces: Uint8Array[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const piece of pieces) controller.enqueue(piece);
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function bodyOf(call: Call): unknown {
  return JSON.parse(call.init.body as string);
}

beforeEach(() => {
  calls = [];
  replies = [];
  const fake = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return replies.shift() ?? json({});
  };
  http = createHttpSource(fake as typeof fetch) as Required<DataSource>;
});

describe("request building", () => {
  test("the source says which edition it is", () => {
    expect(http.edition).toBe("self-hosted");
  });

  test("the entry point hands out the HTTP source and the helpers around it", () => {
    expect(data.edition).toBe("self-hosted");
    expect(ExportedDataError).toBe(DataError);
    expect(exportedOnLocked).toBe(onLocked);
  });

  test("character list builds its query", async () => {
    reply(json([]));
    await http.characters.list({ kind: "scenario", q: " vane " });
    expect(calls[0].url).toBe("api/characters?kind=scenario&q=vane");
  });

  test("character list without a query has no question mark", async () => {
    reply(json([]));
    reply(json([]));
    await http.characters.list();
    await http.characters.list({ q: "   " });
    expect(calls.map((c) => c.url)).toEqual(["api/characters", "api/characters"]);
  });

  test("removeFrom deletes the message and what follows", async () => {
    await http.messages.removeFrom("m1");
    expect(calls[0]).toMatchObject({
      url: "api/messages/m1",
      init: { method: "DELETE" },
    });
  });

  test("clearing a wallpaper hands back the conversation without it", async () => {
    const without = { id: "v1", title: "T", wallpaper_url: null };
    reply(json(without));
    await expect(http.conversations.clearWallpaper("v1")).resolves.toEqual(without);
  });

  test("uploads are multipart without a JSON content type", async () => {
    const file = new File(["pixels"], "face.png", { type: "image/png" });
    await http.personas.uploadAvatar("p1", file);

    const { url, init } = calls[0];
    expect(url).toBe("api/personas/p1/avatar");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    const sent = (init.body as FormData).get("file") as File;
    expect(sent.name).toBe("face.png");
    expect(new Headers(init.headers).has("Content-Type")).toBe(false);
  });

  test("JSON bodies say so", async () => {
    await http.settings.update({ auto_memory: false });
    expect(new Headers(calls[0].init.headers).get("Content-Type")).toBe("application/json");
  });

  test("every variable path segment is encoded", async () => {
    await http.characters.get("a/b?c");
    await http.library.install("a b.json");
    expect(calls.map((c) => c.url)).toEqual([
      "api/characters/a%2Fb%3Fc",
      "api/library/a%20b.json/install",
    ]);
  });

  test("an image read back is a file of the type the server gave", async () => {
    reply(new Response(new Uint8Array([0xff, 0xd8]), { headers: { "Content-Type": "image/jpeg" } }));
    const file = await http.file("api/media/a.jpg");
    expect(calls[0].url).toBe("api/media/a.jpg");
    expect([file.type, file.size]).toEqual(["image/jpeg", 2]);
  });

  test("library avatar names are encoded", () => {
    expect(http.library.avatarUrl("a b.png")).toBe("api/library/a%20b.png/avatar");
  });
});

// One row per call the interface makes today, so that a route or a verb that
// drifts is named by the test that fails.
describe("routes", () => {
  const file = new File(["x"], "f.png", { type: "image/png" });
  const character = {
    kind: "character" as const, name: "Vane", tagline: "", description: "", personality: "",
    scenario: "", greeting: "", alternate_greetings: [], example_dialogues: "", system_prompt: "",
    post_history_instructions: "", creator_notes: "", tags: [], creator: "", character_version: "",
  };
  const connection = {
    name: "Local", provider: "openai-compatible" as const, base_url: "http://localhost:1234/v1",
    model: "m", context_size: 16384, max_tokens: 1024, temperature: 0.8, top_p: 0.95,
    frequency_penalty: 0.15, presence_penalty: 0.15, is_default: false,
  };

  // `body` is the JSON that goes out, or the File of an upload; absent when
  // nothing is sent.
  type Row = [name: string, run: () => Promise<unknown>, method: string, url: string, body?: unknown];
  const rows: Row[] = [
    ["characters.get", () => http.characters.get("c1"), "GET", "api/characters/c1"],
    ["characters.create", () => http.characters.create(character), "POST", "api/characters", character],
    ["characters.update", () => http.characters.update("c1", { is_favorite: true }), "PUT", "api/characters/c1", { is_favorite: true }],
    ["characters.remove", () => http.characters.remove("c1"), "DELETE", "api/characters/c1"],
    ["characters.uploadAvatar", () => http.characters.uploadAvatar("c1", file), "POST", "api/characters/c1/avatar", file],
    [
      "characters.assist",
      () => http.characters.assist({ prompt: "a ferryman", kind: "character", existing: {}, connection_id: null }),
      "POST", "api/characters/assist",
      { prompt: "a ferryman", kind: "character", existing: {}, connection_id: null },
    ],
    ["personas.list", () => http.personas.list(), "GET", "api/personas"],
    [
      "personas.create",
      () => http.personas.create({ name: "Me", description: "", is_default: true }),
      "POST", "api/personas", { name: "Me", description: "", is_default: true },
    ],
    [
      "personas.update",
      () => http.personas.update("p1", { name: "Me", description: "x", is_default: false }),
      "PUT", "api/personas/p1", { name: "Me", description: "x", is_default: false },
    ],
    ["personas.remove", () => http.personas.remove("p1"), "DELETE", "api/personas/p1"],
    ["conversations.list", () => http.conversations.list(), "GET", "api/conversations"],
    [
      "conversations.list for a character",
      () => http.conversations.list({ character_id: "c 1" }),
      "GET", "api/conversations?character_id=c+1",
    ],
    ["conversations.get", () => http.conversations.get("v1"), "GET", "api/conversations/v1"],
    [
      "conversations.create",
      () => http.conversations.create({ character_id: "c1", persona_id: null, connection_id: "k1" }),
      "POST", "api/conversations",
      { character_id: "c1", persona_id: null, connection_id: "k1" },
    ],
    ["conversations.update", () => http.conversations.update("v1", { title: "T" }), "PATCH", "api/conversations/v1", { title: "T" }],
    ["conversations.remove", () => http.conversations.remove("v1"), "DELETE", "api/conversations/v1"],
    ["conversations.setWallpaper", () => http.conversations.setWallpaper("v1", file), "POST", "api/conversations/v1/wallpaper", file],
    ["conversations.clearWallpaper", () => http.conversations.clearWallpaper("v1"), "DELETE", "api/conversations/v1/wallpaper"],
    ["messages.update", () => http.messages.update("m1", { active_index: 1 }), "PATCH", "api/messages/m1", { active_index: 1 }],
    ["messages.branch", () => http.messages.branch("m1"), "POST", "api/messages/m1/branch"],
    ["memories.list", () => http.memories.list("v1"), "GET", "api/conversations/v1/memories"],
    [
      "memories.create",
      () => http.memories.create("v1", { content: "She lies.", is_pinned: true }),
      "POST", "api/conversations/v1/memories", { content: "She lies.", is_pinned: true },
    ],
    ["memories.update", () => http.memories.update("f1", { is_pinned: false }), "PATCH", "api/memories/f1", { is_pinned: false }],
    ["memories.remove", () => http.memories.remove("f1"), "DELETE", "api/memories/f1"],
    ["memories.extract", () => http.memories.extract("v1"), "POST", "api/conversations/v1/memories/extract"],
    ["memories.consolidate", () => http.memories.consolidate("v1"), "POST", "api/conversations/v1/memories/consolidate"],
    [
      "turns.start",
      () => http.turns.start({ conversation_id: "v1", mode: "send", content: "Hi", message_mode: "narrate" }),
      "POST", "api/chat", { conversation_id: "v1", mode: "send", content: "Hi", message_mode: "narrate" },
    ],
    ["turns.stop", () => http.turns.stop("v1"), "DELETE", "api/conversations/v1/turn"],
    ["turns.state", () => http.turns.state("v1"), "GET", "api/conversations/v1/turn"],
    ["turns.impersonate", () => http.turns.impersonate("v1"), "POST", "api/conversations/v1/impersonate"],
    ["library.list", () => http.library.list(), "GET", "api/library"],
    ["library.install", () => http.library.install("vane.json"), "POST", "api/library/vane.json/install"],
    ["settings.get", () => http.settings.get(), "GET", "api/settings"],
    ["settings.update", () => http.settings.update({ reply_length: "long" }), "PUT", "api/settings", { reply_length: "long" }],
    ["connections.list", () => http.connections.list(), "GET", "api/connections"],
    ["connections.create", () => http.connections.create({ ...connection, api_key: "k" }), "POST", "api/connections", { ...connection, api_key: "k" }],
    ["connections.update", () => http.connections.update("k1", connection), "PUT", "api/connections/k1", connection],
    ["connections.remove", () => http.connections.remove("k1"), "DELETE", "api/connections/k1"],
    [
      "connections.test",
      () => http.connections.test({ ...connection, id: "k1" }),
      "POST", "api/connections/test", { ...connection, id: "k1" },
    ],
    [
      "connections.benchmark",
      () => http.connections.benchmark({ ...connection, id: "k1" }),
      "POST", "api/connections/benchmark", { ...connection, id: "k1" },
    ],
    ["updates.get", () => http.updates.get(), "GET", "api/update"],
    ["access.status", () => http.access.status(), "GET", "api/gate"],
    ["access.login", () => http.access.login("open sesame"), "POST", "api/gate", { password: "open sesame" }],
    ["access.logout", () => http.access.logout(), "DELETE", "api/gate"],
    ["access.logoutEverywhere", () => http.access.logoutEverywhere(), "DELETE", "api/gate/sessions"],
  ];

  test.each(rows)("%s", async (name, run, method, url, body) => {
    // 204 for every verb that has nothing to say back, so that none of them
    // fails on an empty body, and a list for the calls that ask for one.
    const nothing = method === "DELETE" || (method === "POST" && url === "api/gate");
    reply(nothing ? new Response(null, { status: 204 }) : json(name.includes(".list") ? [] : {}));
    await run();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(url);
    expect(calls[0].init.method ?? "GET").toBe(method);
    if (body instanceof File) {
      // An upload: one multipart field called "file".
      expect(calls[0].init.body).toBeInstanceOf(FormData);
      expect(((calls[0].init.body as FormData).get("file") as File).name).toBe(body.name);
    } else if (body !== undefined) {
      expect(bodyOf(calls[0])).toEqual(body);
    } else {
      expect(calls[0].init.body).toBeUndefined();
    }
  });
});

describe("errors", () => {
  test("server errors keep their message and kind", async () => {
    reply(json({ error: "Bad", kind: "unreachable" }, 400));
    const failure = await http.turns.impersonate("v1").catch((e) => e);
    expect(failure).toBeInstanceOf(DataError);
    expect(failure.message).toBe("Bad");
    expect(failure.kind).toBe("unreachable");
    expect(failure.status).toBe(400);
  });

  test("a validation error keeps FastAPI's detail as its message, with no kind", async () => {
    const detail = [{ loc: ["body", "name"], msg: "Field required", type: "missing" }];
    reply(json({ detail }, 422));
    const failure = await http.personas.create({ name: "", description: "", is_default: false }).catch((e) => e);
    expect(failure).toBeInstanceOf(DataError);
    expect(failure.message).toBe(JSON.stringify(detail));
    expect(failure.status).toBe(422);
    expect(failure.kind).toBeUndefined();
  });

  test("an answer that is not JSON is an HTTP error with its status", async () => {
    reply(new Response("<html>Bad gateway</html>", { status: 502 }));
    const failure = await http.settings.get().catch((e) => e);
    expect(failure).toBeInstanceOf(DataError);
    expect(failure.kind).toBe("http_error");
    expect(failure.status).toBe(502);
    expect(failure.message).toBe("HTTP 502");
  });

  test("an empty answer is an HTTP error too", async () => {
    reply(new Response("", { status: 500 }));
    const failure = await http.settings.get().catch((e) => e);
    expect(failure.kind).toBe("http_error");
    expect(failure.status).toBe(500);
    expect(failure.message).toBe("HTTP 500");
  });

  test("JSON with nothing to say is an HTTP error as well", async () => {
    reply(json({}, 503));
    const failure = await http.settings.get().catch((e) => e);
    expect(failure.kind).toBe("http_error");
    expect(failure.message).toBe("HTTP 503");
  });

  test("a server message without a kind has no kind", async () => {
    reply(json({ error: "Nope" }, 400));
    const failure = await http.settings.get().catch((e) => e);
    expect(failure.kind).toBeUndefined();
    expect(failure.message).toBe("Nope");
  });

  test("what a missing thing was is carried along", async () => {
    reply(json({ error: "Character not found.", kind: "not_found", resource: "character" }, 404));
    const failure = await http.characters.get("gone").catch((e) => e);
    expect(failure.kind).toBe("not_found");
    expect(failure.resource).toBe("character");
  });

  test("what a model's server said is carried along, in its own words", async () => {
    reply(json({
      error: "LLM server error (503). Overloaded", kind: "model_http_error",
      upstream: "Overloaded", upstream_status: 503,
    }, 502));
    const failure = await http.turns.impersonate("v1").catch((e) => e);
    expect(failure.kind).toBe("model_http_error");
    expect(failure.status).toBe(502);
    expect(failure.upstream).toBe("Overloaded");
    expect(failure.upstreamStatus).toBe(503);
  });

  test("the address that could not be reached is carried along", async () => {
    reply(json({ error: "Cannot reach http://x/v1.", kind: "unreachable", upstream_url: "http://x/v1" }, 502));
    const failure = await http.turns.impersonate("v1").catch((e) => e);
    expect(failure.upstreamUrl).toBe("http://x/v1");
  });

  test("an upstream that is not text, or a status that is not a number, is left out", async () => {
    reply(json({ error: "Words", kind: "model_http_error", upstream: { a: 1 }, upstream_status: "503" }, 502));
    const failure = await http.turns.impersonate("v1").catch((e) => e);
    expect(failure.upstream).toBeUndefined();
    expect(failure.upstreamStatus).toBeUndefined();
  });

  test("a call that never got an answer is a network error", async () => {
    const dropped = new TypeError("Failed to fetch");
    const offline = createHttpSource((() => Promise.reject(dropped)) as typeof fetch);
    const failure = await offline.settings.get().catch((e) => e);
    expect(failure).toBeInstanceOf(DataError);
    expect(failure.kind).toBe("network");
    expect(failure.status).toBeUndefined();
    expect(failure.cause).toBe(dropped);
  });

  test("an abort is not a network error", async () => {
    const aborted = new DOMException("The operation was aborted.", "AbortError");
    const source = createHttpSource((() => Promise.reject(aborted)) as typeof fetch);
    await expect(source.settings.get()).rejects.toBe(aborted);
  });

  test("204 resolves to undefined", async () => {
    reply(new Response(null, { status: 204 }));
    await expect(http.characters.remove("c1")).resolves.toBeUndefined();
  });

  test("rate limiting carries Retry-After", async () => {
    reply(json({ error: "Too many attempts.", kind: "rate_limited" }, 429, { "Retry-After": "120" }));
    const failure = await http.access.login("guess").catch((e) => e);
    expect(failure).toBeInstanceOf(DataError);
    expect(failure.kind).toBe("rate_limited");
    expect(failure.status).toBe(429);
    expect(failure.retryAfter).toBe(120);
  });

  test("a missing or unreadable Retry-After is left out", async () => {
    reply(json({ error: "Down" }, 503));
    reply(json({ error: "Down" }, 503, { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }));
    const first = await http.settings.get().catch((e) => e);
    const second = await http.settings.get().catch((e) => e);
    expect(first.retryAfter).toBeUndefined();
    expect(second.retryAfter).toBeUndefined();
  });

  test("a wrong password is told apart from a locked session", async () => {
    const locked = vi.fn();
    const stop = onLocked(locked);
    try {
      reply(json({ error: "Wrong password.", kind: "wrong_password" }, 401));
      const failure = await http.access.login("nope").catch((e) => e);
      expect(failure.kind).toBe("wrong_password");
      expect(locked).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});

describe("locked sessions", () => {
  const stops: Array<() => void> = [];
  afterEach(() => {
    stops.splice(0).forEach((stop) => stop());
  });

  test("a locked API calls the handler once, then rejects", async () => {
    const handler = vi.fn();
    stops.push(onLocked(handler));
    reply(json({ error: "Locked.", kind: "locked" }, 401));

    const failure = await http.characters.list().catch((e) => e);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(DataError);
    expect(failure.kind).toBe("locked");
    expect(failure.status).toBe(401);
  });

  test("a locked stream reaches the handler too", async () => {
    const handler = vi.fn();
    stops.push(onLocked(handler));
    reply(json({ error: "Locked.", kind: "locked" }, 401));

    const failure = await http.turns.follow("v1", () => {}).catch((e) => e);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(failure.kind).toBe("locked");
  });

  test("a handler that was removed is no longer called", async () => {
    const handler = vi.fn();
    onLocked(handler)();
    reply(json({ error: "Locked.", kind: "locked" }, 401));

    await http.characters.list().catch(() => {});

    expect(handler).not.toHaveBeenCalled();
  });

  test("a handler that throws neither replaces the error nor silences the others", async () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    const bug = new Error("handler bug");
    const broken = vi.fn(() => {
      throw bug;
    });
    const after = vi.fn();
    stops.push(onLocked(broken), onLocked(after));
    reply(json({ error: "Locked.", kind: "locked" }, 401));

    const failure = await http.characters.list().catch((e) => e);

    expect(broken).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(DataError);
    expect(failure.kind).toBe("locked");
    expect(failure.status).toBe(401);
    // Nobody is left to hear it but the console, which is where a bug is looked for.
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]).toContain(bug);
  });

  test("a 401 that is not about the lock leaves the handler alone", async () => {
    const handler = vi.fn();
    stops.push(onLocked(handler));
    reply(json({ error: "Nope" }, 401));

    await http.characters.list().catch(() => {});

    expect(handler).not.toHaveBeenCalled();
  });
});

describe("fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("the one a source starts with is looked up when a call is made", async () => {
    const source = createHttpSource();
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return json([]);
    });
    await source.characters.list();
    expect(seen).toEqual(["api/characters"]);
  });

  test("and so is the one the request helpers start with", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return json({});
    });
    await request("api/one");
    await send("api/two");
    expect(seen).toEqual(["api/one", "api/two"]);
  });
});

describe("turns", () => {
  test("turn events survive chunk boundaries", async () => {
    reply(chunked('data: {"text":"He"}\n\nda', 'ta: {"delta":"llo"}\n\n'));
    const events: TurnEvent[] = [];

    await http.turns.follow("v1", (e) => events.push(e));

    expect(events).toEqual([{ text: "He" }, { delta: "llo" }]);
  });

  test("the last event counts even without a closing blank line", async () => {
    reply(chunked('data: {"end":true}'));
    const events: TurnEvent[] = [];

    await http.turns.follow("v1", (e) => events.push(e));

    expect(events).toEqual([{ end: true }]);
  });

  test("garbage between events is skipped", async () => {
    reply(chunked(': keep-alive\n\ndata: {oops\n\ndata: {"delta":"Hi"}\n\n'));
    const events: TurnEvent[] = [];

    await http.turns.follow("v1", (e) => events.push(e));

    expect(events).toEqual([{ delta: "Hi" }]);
  });

  test("a character cut in two between chunks arrives whole", async () => {
    const bytes = new TextEncoder().encode('data: {"delta":"Zoé 紅"}\n\n');
    // Inside "é", which is two bytes, and inside "紅", which is three.
    const cuts = [bytes.indexOf(0xc3) + 1, bytes.indexOf(0xe7) + 1];
    reply(chunkedBytes(
      bytes.slice(0, cuts[0]), bytes.slice(cuts[0], cuts[1]), bytes.slice(cuts[1]),
    ));
    const events: TurnEvent[] = [];

    await http.turns.follow("v1", (e) => events.push(e));

    expect(events).toEqual([{ delta: "Zoé 紅" }]);
  });

  test("a handler that throws makes following reject and lets the connection go", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    reply(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"delta":"Hi"}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    })));
    const bug = new Error("handler bug");

    const failure = await http.turns
      .follow("v1", () => {
        throw bug;
      })
      .catch((e) => e);

    expect(failure).toBe(bug);
    // Left open, the server would go on writing to a page that has stopped listening.
    expect(cancelled).toBe(true);
  });

  test("starting answers with the message as the server saved it", async () => {
    const saved = { id: "m1", content: "Hi" };
    reply(json({ user_message: saved }));

    expect(await http.turns.start({ conversation_id: "v1", mode: "send", content: "Hi" }))
      .toEqual({ user_message: saved });
    expect(new Headers(calls[0].init.headers).get("Content-Type")).toBe("application/json");
  });

  test("a refused turn rejects with what the server said", async () => {
    reply(json({ error: "No LLM connection configured.", kind: "no_connection" }, 400));
    const failure = await http.turns.start({ conversation_id: "v1", mode: "send" }).catch((e) => e);
    expect(failure).toBeInstanceOf(DataError);
    expect(failure.kind).toBe("no_connection");
    expect(failure.status).toBe(400);
  });

  test("following a turn hands the signal to fetch", async () => {
    reply(chunked());
    const controller = new AbortController();

    await http.turns.follow("v1", () => {}, controller.signal);

    expect(calls[0].url).toBe("api/conversations/v1/turn/stream");
    expect(calls[0].init.method ?? "GET").toBe("GET");
    expect(calls[0].init.signal).toBe(controller.signal);
  });

  test("a connection that never opens is a network error", async () => {
    const dropped = new TypeError("Failed to fetch");
    const offline = createHttpSource((() => Promise.reject(dropped)) as typeof fetch);
    const failure = await offline.turns.follow("v1", () => {}).catch((e) => e);
    expect(failure).toBeInstanceOf(DataError);
    expect(failure.kind).toBe("network");
    expect(failure.cause).toBe(dropped);
  });

  test("a connection that drops in the middle of a reply is a network error", async () => {
    const dropped = new TypeError("network error");
    const encoder = new TextEncoder();
    let sent = false;
    reply(new Response(new ReadableStream({
      pull(controller) {
        if (sent) throw dropped;
        sent = true;
        controller.enqueue(encoder.encode('data: {"delta":"Hi"}\n\n'));
      },
    })));
    const events: TurnEvent[] = [];

    const failure = await http.turns.follow("v1", (e) => events.push(e)).catch((e) => e);

    expect(events).toEqual([{ delta: "Hi" }]);
    expect(failure).toBeInstanceOf(DataError);
    expect(failure.kind).toBe("network");
    expect(failure.cause).toBe(dropped);
  });

  test("an abort in the middle of a reply stays an abort", async () => {
    const aborted = new DOMException("The operation was aborted.", "AbortError");
    reply(new Response(new ReadableStream({
      pull() {
        throw aborted;
      },
    })));
    await expect(http.turns.follow("v1", () => {})).rejects.toBe(aborted);
  });
});

// The interface can be served from under a path (`/evermind/`, behind a reverse
// proxy that strips it), and the page's own address is always the root of the
// app, since its routes live after the "#". An address with a leading slash
// would ignore that path, so none is written with one.
describe("under a path prefix", () => {
  const page = "http://192.168.1.42:3000/evermind/";
  const resolved = (url: string) => new URL(url, page).href;

  test("every call, stream and upload resolves under the prefix", async () => {
    const file = new File(["x"], "f.png", { type: "image/png" });
    reply(json([]));
    reply(json({}));
    reply(json({}));
    reply(json({ user_message: null }));
    reply(chunked());
    reply(json({}));
    await http.characters.list();
    await http.characters.get("c1");
    await http.characters.uploadAvatar("c1", file);
    await http.turns.start({ conversation_id: "v1", mode: "send" });
    await http.turns.follow("v1", () => {});
    await http.conversations.setWallpaper("v1", file);

    expect(calls.map((c) => resolved(c.url))).toEqual([
      "http://192.168.1.42:3000/evermind/api/characters",
      "http://192.168.1.42:3000/evermind/api/characters/c1",
      "http://192.168.1.42:3000/evermind/api/characters/c1/avatar",
      "http://192.168.1.42:3000/evermind/api/chat",
      "http://192.168.1.42:3000/evermind/api/conversations/v1/turn/stream",
      "http://192.168.1.42:3000/evermind/api/conversations/v1/wallpaper",
    ]);
  });

  test("so does the address of a library illustration", () => {
    expect(resolved(http.library.avatarUrl("vane.json"))).toBe(
      "http://192.168.1.42:3000/evermind/api/library/vane.json/avatar",
    );
  });

  test("and the same address served from the root stays at the root", () => {
    expect(new URL(http.library.avatarUrl("vane.json"), "http://localhost:3000/").pathname).toBe(
      "/api/library/vane.json/avatar",
    );
  });
});

describe("access", () => {
  test("status returns what the server says", async () => {
    reply(json({ enabled: true, authenticated: false }));
    await expect(http.access.status()).resolves.toEqual({ enabled: true, authenticated: false });
  });

  test("a successful login resolves to nothing", async () => {
    reply(new Response(null, { status: 204 }));
    await expect(http.access.login("right")).resolves.toBeUndefined();
  });
});
