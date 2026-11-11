import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { data, DataError, onLocked } from "@/data";
import type { TurnEvent } from "@/types";

let calls: { url: string; init: RequestInit }[];
let replies: (Response | Error)[];

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/** A body that arrives in the given pieces, to put chunk boundaries where the test wants them. */
function chunked(...pieces: (string | Uint8Array)[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(typeof piece === "string" ? encoder.encode(piece) : piece);
      controller.close();
    },
  }));
}

beforeEach(() => {
  calls = [];
  replies = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = replies.shift() ?? json({});
    if (next instanceof Error) throw next;
    return next;
  });
});
afterEach(() => vi.unstubAllGlobals());

const failureOf = () => data.settings.get().catch((e) => e);

describe("what is sent", () => {
  test("an address is relative, its segments are encoded, and its query is there only when set", async () => {
    replies.push(json({}), json([]), json([]));
    await data.characters.get("a/b?c");
    await data.conversations.list({ character_id: "c1" });
    await data.conversations.list();
    expect(calls.map((c) => c.url)).toEqual([
      "api/characters/a%2Fb%3Fc", "api/conversations?character_id=c1", "api/conversations",
    ]);
    expect(data.library.avatarUrl("a b.png")).toBe("api/library/a%20b.png/avatar");
  });

  test("JSON says so, and an upload leaves its type to the browser", async () => {
    await data.settings.update({ auto_memory: false });
    expect(new Headers(calls[0].init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ auto_memory: false });

    await data.personas.uploadAvatar("p1", new File(["x"], "face.png"));
    expect((calls[1].init.body as FormData).get("file")).toBeInstanceOf(File);
    expect(new Headers(calls[1].init.headers).has("Content-Type")).toBe(false);
  });

  test("removing a message removes it and everything after it", async () => {
    replies.push(new Response(null, { status: 204 }));
    await data.messages.removeFrom("m1");
    expect(calls[0]).toMatchObject({ url: "api/messages/m1", init: { method: "DELETE" } });
  });

  test("following a turn reads its stream with the signal it was given", async () => {
    const { signal } = new AbortController();
    replies.push(chunked());
    await data.turns.follow("v1", () => {}, signal);
    expect(calls[0].url).toBe("api/conversations/v1/turn/stream");
    expect(calls[0].init.signal).toBe(signal);
  });

  test("the turn's state and the conversation are asked past any cache, where a request left hanging would hold them", async () => {
    await data.turns.state("v1");
    await data.conversations.get("v1");
    await data.conversations.withoutMessages("v1");
    expect(calls.map((c) => [c.url, c.init.cache])).toEqual([
      ["api/conversations/v1/turn", "no-store"], ["api/conversations/v1", "no-store"],
      ["api/conversations/v1?messages=false", "no-store"],
    ]);
  });

  test("the card assistant starts a job under the id the page drew, asks how it stands past any cache, and stops it", async () => {
    replies.push(json({ id: "j1" }, 202), json({ id: "j1", running: true }), json({ id: "j1", running: false }));
    const input = { prompt: "A tired lighthouse keeper", kind: "character" as const, existing: {}, connection_id: null, client_id: "c1" };
    await expect(data.characters.assist.start(input)).resolves.toEqual({ id: "j1" });
    await data.characters.assist.state("j/1");
    await data.characters.assist.stop("j1");
    expect(calls.map((c) => [c.url, c.init.method ?? "GET", c.init.cache])).toEqual([
      ["api/characters/assist", "POST", undefined],
      ["api/characters/assist/j%2F1", "GET", "no-store"],
      ["api/characters/assist/j1", "DELETE", undefined],
    ]);
    expect(JSON.parse(calls[0].init.body as string)).toEqual(input);
  });

  test("an image read back is a file of the type the server gave", async () => {
    replies.push(new Response(new Uint8Array([0xff, 0xd8]), { headers: { "Content-Type": "image/jpeg" } }));
    const file = await data.file("api/media/a.jpg");
    expect([calls[0].url, file.type, file.size]).toEqual(["api/media/a.jpg", "image/jpeg", 2]);
  });
});

describe("what comes back", () => {
  test("204 is nothing", async () => {
    replies.push(new Response(null, { status: 204 }));
    await expect(data.characters.remove("c1")).resolves.toBeUndefined();
  });

  test("a server's error keeps its words and details, and a wait counted in seconds", async () => {
    replies.push(
      json({ error: "Character not found.", kind: "not_found", resource: "character" }, 404, { "Retry-After": "120" }),
      json({ error: "Down" }, 503, { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }),
    );
    const failure = await failureOf();
    expect(failure).toBeInstanceOf(DataError);
    expect(failure).toMatchObject({
      message: "Character not found.", kind: "not_found", resource: "character", status: 404, retryAfter: 120,
    });
    expect(await failureOf()).toMatchObject({ message: "Down", kind: undefined, status: 503, retryAfter: undefined });
  });

  test("a validation error keeps FastAPI's detail", async () => {
    const detail = [{ loc: ["body", "name"], msg: "Field required" }];
    replies.push(json({ detail }, 422));
    expect(await failureOf()).toMatchObject({ message: JSON.stringify(detail), status: 422, kind: undefined });
  });

  test.each([
    ["HTML from a proxy", new Response("<html>Bad gateway</html>", { status: 502 }), 502],
    ["an empty answer", new Response("", { status: 500 }), 500],
    ["JSON with nothing to say", json({}, 503), 503],
  ])("%s is an HTTP error with its status", async (_name, response, status) => {
    replies.push(response);
    expect(await failureOf()).toMatchObject({ kind: "http_error", status, message: `HTTP ${status}` });
  });

  test("no answer at all is a network error, offline when the browser knows it, and an abort stays an abort", async () => {
    const dropped = new TypeError("Failed to fetch");
    const aborted = new DOMException("Aborted", "AbortError");
    replies.push(dropped, dropped, aborted);
    expect(await failureOf()).toMatchObject({ kind: "network", cause: dropped, status: undefined });
    vi.stubGlobal("navigator", { onLine: false });
    expect(await failureOf()).toMatchObject({ kind: "offline" });
    expect(await failureOf()).toBe(aborted);
  });
});

describe("a session that ended", () => {
  test("a locked answer tells the handler, on a stream too, then rejects", async () => {
    const handler = vi.fn();
    onLocked(handler);
    replies.push(json({ error: "Locked.", kind: "locked" }, 401), json({ error: "Locked.", kind: "locked" }, 401));
    expect(await failureOf()).toMatchObject({ kind: "locked", status: 401 });
    expect(await data.turns.follow("v1", () => {}).catch((e) => e)).toMatchObject({ kind: "locked" });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  test("a wrong password does not", async () => {
    const handler = vi.fn();
    onLocked(handler);
    replies.push(json({ error: "Wrong password.", kind: "wrong_password" }, 401));
    expect(await data.access.login("nope").catch((e) => e)).toMatchObject({ kind: "wrong_password" });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("a stream of events", () => {
  async function follow(response: Response) {
    const events: TurnEvent[] = [];
    replies.push(response);
    const failure = await data.turns.follow("v1", (e) => events.push(e)).then(() => undefined, (e) => e);
    return { events, failure };
  }
  const hi = { delta: "Hi" };

  test("an event survives a chunk boundary", async () => {
    const { events } = await follow(chunked('data: {"delta":', '"Hi"}\n\nda', 'ta: {"delta":"Hi"}\n\n'));
    expect(events).toEqual([hi, hi]);
  });

  test("a character cut in two arrives whole", async () => {
    const bytes = new TextEncoder().encode('data: {"delta":"Zoé 紅"}\n\n');
    // Inside "é", which is two bytes, and inside "紅", which is three.
    const cuts = [bytes.indexOf(0xc3) + 1, bytes.indexOf(0xe7) + 1];
    const { events } = await follow(chunked(bytes.slice(0, cuts[0]), bytes.slice(cuts[0], cuts[1]), bytes.slice(cuts[1])));
    expect(events).toEqual([{ delta: "Zoé 紅" }]);
  });

  test("the last event counts without a closing blank line, and garbage is skipped", async () => {
    const { events } = await follow(chunked(': keep-alive\n\ndata: {oops\n\ndata: {"text":"He"}\n\ndata: {"end":true}'));
    expect(events).toEqual([{ text: "He" }, { end: true }]);
  });

  test("a body with nothing in it yields nothing", async () => {
    expect(await follow(new Response(""))).toEqual({ events: [], failure: undefined });
    expect(await follow(new Response(null))).toEqual({ events: [], failure: undefined });
  });

  test("a drop in the middle keeps what arrived and is a network error", async () => {
    const dropped = new TypeError("network error");
    let sent = false;
    const { events, failure } = await follow(new Response(new ReadableStream({
      pull(controller) {
        if (sent) throw dropped;
        sent = true;
        controller.enqueue(new TextEncoder().encode('data: {"delta":"Hi"}\n\n'));
      },
    })));
    expect(events).toEqual([hi]);
    expect(failure).toMatchObject({ kind: "network", cause: dropped });
  });

  test("an abort in the middle stays an abort", async () => {
    const aborted = new DOMException("Aborted", "AbortError");
    const { failure } = await follow(new Response(new ReadableStream({ pull() { throw aborted; } })));
    expect(failure).toBe(aborted);
  });

  test("a handler that throws rejects the following and lets the connection go", async () => {
    const bug = new Error("handler bug");
    let cancelled = false;
    replies.push(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"delta":"Hi"}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    })));
    expect(await data.turns.follow("v1", () => { throw bug; }).catch((e) => e)).toBe(bug);
    // Left open, the server would go on writing to a page that has stopped listening.
    expect(cancelled).toBe(true);
  });
});

/** A server that answers once it is let, or never, and sees a request given up on. */
function answering() {
  let answer = () => {};
  const given: AbortSignal[] = [];
  vi.stubGlobal("fetch", (_input: RequestInfo | URL, init: RequestInit = {}) => {
    given.push(init.signal!);
    return new Promise<Response>((resolve, reject) => {
      answer = () => resolve(json({ running: false, outcome: null, revision: 1 }));
      const givenUp = () => reject(new DOMException("Aborted", "AbortError"));
      if (init.signal?.aborted) givenUp();
      init.signal?.addEventListener("abort", givenUp);
    });
  });
  return { given, answer: () => answer() };
}

describe("patience", () => {
  test("a question whose answer has not begun in time is given up on, as unanswered", async () => {
    const server = answering();
    const questions = [
      data.turns.state("v1", { within: 20 }), data.turns.stop("v1", { within: 20 }),
      data.characters.assist.state("j1", { within: 20 }),
    ];
    for (const asked of questions) {
      expect(await asked.catch((e) => e)).toMatchObject({ name: "DataError", kind: "network" });
    }
    expect(server.given.map((signal) => signal.aborted), "they are left hanging on a connection").toEqual([true, true, true]);
  });

  test("is for the answer to begin, not for all of it to arrive", async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init: RequestInit = {}) => new Response(new ReadableStream({
      async start(controller) {
        // As a browser does: giving up on a request breaks a body still on its way.
        init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        controller.enqueue(encoder.encode('{"id": "v1", '));
        await new Promise((resolve) => setTimeout(resolve, 60));
        controller.enqueue(encoder.encode('"title": "Long"}'));
        controller.close();
      },
    })));
    await expect(data.conversations.get("v1", { within: 20 })).resolves.toEqual({ id: "v1", title: "Long" });
  });

  test("a question its asker gives up on stays given up on", async () => {
    const server = answering();
    const asker = new AbortController();
    const asked = data.conversations.get("v1", { signal: asker.signal, within: 10_000 });
    asker.abort();
    await expect(asked).rejects.toHaveProperty("name", "AbortError");
    await expect(data.turns.state("v1", { signal: asker.signal, within: 10_000 })).rejects.toHaveProperty("name", "AbortError");
    expect(server.given.map((signal) => signal.aborted)).toEqual([true, true]);
  });

  test("an answer in time is the answer", async () => {
    const server = answering();
    const asked = data.turns.stop("v1", { within: 10_000 });
    server.answer();
    await expect(asked).resolves.toEqual({ running: false, outcome: null, revision: 1 });
  });
});
