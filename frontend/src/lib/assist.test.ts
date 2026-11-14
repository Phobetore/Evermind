import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DataError } from "@/data/errors";
import type { AssistState } from "@/data";
import {
  clientIdFor, describeOutcome, fieldsToTake, follow, forgetJob, formatClock, kept, moveJob, outcome, progress,
  rememberJob, rememberedJob, scopeOf, type Followed,
} from "./assist";
import { blockStorage, MemoryStorage, useStorage } from "./storage.fake";

/** A state as the server gives it, a job just begun unless said otherwise. */
function aState(changes: Partial<AssistState> = {}): AssistState {
  return {
    id: "j1", running: true, seconds: 0, thought: 0, written: 0, fields: [], lore: 0, writing: null,
    draft: null, missing: [], cut: false, stopped: false, error: null, ...changes,
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("a job being remembered", () => {
  beforeEach(() => useStorage(new MemoryStorage()));

  test("is kept for its card until it is forgotten, and not for another", () => {
    rememberJob("c1", { id: "j1", brief: "A tired keeper", kind: "scenario" });
    expect(rememberedJob("c1")).toEqual({ id: "j1", brief: "A tired keeper", kind: "scenario" });
    expect(rememberedJob("c2")).toBeNull();
    expect(rememberedJob("new")).toBeNull();
    forgetJob("c1");
    expect(rememberedJob("c1")).toBeNull();
  });

  test("goes under a key of its own, with the card's id, or new for a card not saved yet", () => {
    const storage = new MemoryStorage();
    useStorage(storage);
    rememberJob(scopeOf(undefined), { id: "j1", brief: "x", kind: "character" });
    rememberJob(scopeOf("c1"), { id: "j2", brief: "y", kind: "character" });
    expect(Object.keys(storage).sort()).toEqual(["evermind:assist:c1", "evermind:assist:new"]);
    expect(JSON.parse(storage.getItem("evermind:assist:new")!)).toEqual({ id: "j1", brief: "x", kind: "character" });
  });

  test("a kind nobody knows, in storage, is a character", () => {
    localStorage.setItem("evermind:assist:c1", JSON.stringify({ id: "j1", brief: "x", kind: "poem" }));
    expect(rememberedJob("c1")?.kind).toBe("character");
  });

  test.each([
    ["words that are no JSON", "{oops"],
    ["JSON of another shape", JSON.stringify({ id: 7, brief: "x" })],
    ["JSON with nothing in it", "null"],
  ])("%s, in storage, is no job", (_name, stored) => {
    localStorage.setItem("evermind:assist:c1", stored);
    expect(rememberedJob("c1")).toBeNull();
  });

  test("blocked storage loses the job and nothing else", () => {
    blockStorage();
    expect(() => rememberJob("c1", { id: "j1", brief: "x", kind: "character" })).not.toThrow();
    expect(rememberedJob("c1")).toBeNull();
    expect(() => forgetJob("c1")).not.toThrow();
  });

  test("storage that refuses to write keeps the page going", () => {
    const full = new MemoryStorage();
    full.setItem = () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
    useStorage(full);
    expect(() => rememberJob("c1", { id: "j1", brief: "x", kind: "character" })).not.toThrow();
    expect(rememberedJob("c1")).toBeNull();
  });
});

describe("a job that follows its card", () => {
  beforeEach(() => useStorage(new MemoryStorage()));

  test("a job begun on a card not saved yet is the saved card's, and the next new card does not find it", () => {
    rememberJob("new", { id: "j1", brief: "A keeper", kind: "scenario" });
    moveJob("new", "c1");
    expect(rememberedJob("c1")).toEqual({ id: "j1", brief: "A keeper", kind: "scenario" });
    expect(rememberedJob("new")).toBeNull();
  });

  test("with no job, nothing moves, and a job of the saved card is not touched", () => {
    rememberJob("c1", { id: "j2", brief: "x", kind: "character" });
    moveJob("new", "c1");
    expect(rememberedJob("c1")?.id).toBe("j2");
  });

  test("blocked storage breaks nothing", () => {
    blockStorage();
    expect(() => moveJob("new", "c1")).not.toThrow();
  });
});

describe("the id a start goes out under", () => {
  let drawn = 0;
  const draw = () => `drawn-${++drawn}`;

  test("a start whose answer was lost is asked again under the same id while the brief is the same", () => {
    expect(clientIdFor({ clientId: "kept", brief: "A keeper" }, "A keeper", draw)).toBe("kept");
  });

  test("a changed brief, or no start lost, draws a new one", () => {
    expect(clientIdFor({ clientId: "kept", brief: "A keeper" }, "A keeper, older", draw)).toBe("drawn-1");
    expect(clientIdFor(null, "A keeper", draw)).toBe("drawn-2");
  });
});

describe("what the form takes of a card once it is written", () => {
  test("a field typed while the card was written is kept", () => {
    expect(fieldsToTake({ name: "Typed", tagline: "" }, { name: "Mira", tagline: "Keeper" })).toEqual({ tagline: "Keeper" });
  });

  test("an empty field takes what the model wrote, and so does one of spaces", () => {
    expect(fieldsToTake({ name: "", description: "   " }, { name: "Mira", description: "Tired." })).toEqual({
      name: "Mira", description: "Tired.",
    });
  });

  test("lists too: one with something in it is kept, an empty one is filled", () => {
    const form = { tags: ["mine"], alternate_greetings: [] as string[] };
    expect(fieldsToTake(form, { tags: ["sea"], alternate_greetings: ["Hello."] })).toEqual({
      alternate_greetings: ["Hello."],
    });
  });

  test("a field the form does not hold at all is taken", () => {
    expect(fieldsToTake({}, { greeting: "Come in." })).toEqual({ greeting: "Come in." });
  });
});

/** The page the job is followed from: the time it is asked at, and what it is told. */
function following(answers: (call: number) => AssistState | Error | Promise<AssistState>) {
  const asked: number[] = [];
  const told: AssistState[] = [];
  const waiting: boolean[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const withins: (number | undefined)[] = [];
  const aborter = new AbortController();
  // A request given up on rejects, as the browser's does.
  const givenUp = new Promise<never>((_, reject) =>
    aborter.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
  givenUp.catch(() => {});
  const state = vi.fn(async (_id: string, asking: { signal?: AbortSignal; within?: number }) => {
    asked.push(Date.now());
    signals.push(asking.signal);
    withins.push(asking.within);
    const answer = await Promise.race([answers(asked.length), givenUp]);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  let result: Followed | undefined;
  const run = follow("j1", {
    signal: aborter.signal,
    onState: (s) => told.push(s),
    onWaiting: (w) => waiting.push(w),
    state,
  }).then((r) => (result = r));
  return {
    asked, told, waiting, signals, withins, state, run, aborter,
    result: () => result,
    /** Time goes by; what was due in it happens. */
    pass: (ms: number) => vi.advanceTimersByTimeAsync(ms),
  };
}

const unanswered = () => new DataError("No answer in time.", { kind: "network" });

describe("following a job", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("asks every second while it runs, and ends with the job", async () => {
    const over = aState({ running: false, seconds: 3.1, draft: { name: "Mira" } });
    const job = following((call) => (call < 4 ? aState({ seconds: call }) : over));
    await job.pass(0);
    expect(job.asked).toEqual([0]);
    await job.pass(999);
    expect(job.asked).toEqual([0]);
    await job.pass(1);
    expect(job.asked).toEqual([0, 1000]);
    await job.pass(2000);
    expect(job.asked).toEqual([0, 1000, 2000, 3000]);
    await job.run;
    expect(job.result()).toEqual({ kind: "ended", state: over });
    expect(job.told).toHaveLength(4);
    expect(job.told.at(-1)).toBe(over);
    await job.pass(10_000);
    expect(job.asked, "nothing is asked of a job that ended").toHaveLength(4);
  });

  test("gives each question ten seconds, and the signal it can be given up on with", async () => {
    const job = following(() => aState({ running: false }));
    await job.run;
    expect(job.withins).toEqual([10_000]);
    expect(job.signals[0]).toBe(job.aborter.signal);
  });

  test("a question that gets no answer is asked again, later each time, and the following goes on", async () => {
    const over = aState({ running: false });
    const job = following((call) => (call <= 5 ? unanswered() : over));
    await job.pass(0);
    expect(job.waiting).toEqual([true]);
    // 2 s, then 4, then at most 8 between two tries.
    await job.pass(2000);
    await job.pass(4000);
    await job.pass(8000);
    await job.pass(8000);
    expect(job.asked).toEqual([0, 2000, 6000, 14_000, 22_000]);
    expect(job.result()).toBeUndefined();
    await job.pass(8000);
    await job.run;
    expect(job.asked.at(-1)).toBe(30_000);
    expect(job.result()).toEqual({ kind: "ended", state: over });
    expect(job.waiting.at(-1), "told it is no longer waiting").toBe(false);
  });

  test("an answer after a silence goes back to every second", async () => {
    const job = following((call) => (call === 1 ? unanswered() : aState()));
    await job.pass(2000 + 2000);
    expect(job.asked).toEqual([0, 2000, 3000, 4000]);
    expect(job.waiting).toEqual([true, false, false, false]);
    job.aborter.abort();
    await job.run;
  });

  test("no connection at all is no answer either, and is tried again", async () => {
    const job = following((call) => (call === 1 ? new DataError("Network error", { kind: "offline" }) : aState({ running: false })));
    await job.pass(2000);
    await job.run;
    expect(job.result()?.kind).toBe("ended");
  });

  function pageIs(visibility: "visible" | "hidden") {
    const page = Object.assign(new EventTarget(), { visibilityState: visibility });
    vi.stubGlobal("document", page);
    return {
      shows: () => {
        page.visibilityState = "visible";
        page.dispatchEvent(new Event("visibilitychange"));
      },
      hides: () => {
        page.visibilityState = "hidden";
        page.dispatchEvent(new Event("visibilitychange"));
      },
    };
  }

  test("a page that becomes visible asks at once", async () => {
    const page = pageIs("hidden");
    const job = following(() => aState());
    await job.pass(300);
    expect(job.asked).toEqual([0]);
    page.shows();
    await job.pass(0);
    expect(job.asked).toEqual([0, 300]);
    job.aborter.abort();
    await job.run;
  });

  test("and so does one that becomes visible while it waits for the connection", async () => {
    const page = pageIs("hidden");
    const job = following((call) => (call < 3 ? unanswered() : aState({ running: false })));
    await job.pass(500);
    page.shows();
    await job.pass(0);
    expect(job.asked, "no waiting out the 2 s").toEqual([0, 500]);
    // The next wait is the longer one, all the same.
    await job.pass(3999);
    expect(job.asked).toHaveLength(2);
    await job.pass(1);
    await job.run;
    expect(job.asked).toEqual([0, 500, 4500]);
  });

  test("a page that goes out of sight is no reason to ask", async () => {
    const page = pageIs("visible");
    const job = following(() => aState());
    await job.pass(300);
    page.hides();
    await job.pass(0);
    expect(job.asked).toEqual([0]);
    job.aborter.abort();
    await job.run;
  });

  test("a job the server does not know ends the following, as no longer there", async () => {
    const job = following(() => new DataError("Not found", { kind: "not_found", resource: "assist", status: 404 }));
    await job.run;
    expect(job.result()).toEqual({ kind: "gone" });
    await job.pass(60_000);
    expect(job.asked).toHaveLength(1);
  });

  test("any other failure ends it with that failure", async () => {
    const refused = new DataError("Locked.", { kind: "locked", status: 401 });
    const job = following((call) => (call === 1 ? aState() : refused));
    await job.pass(1000);
    await job.run;
    expect(job.result()).toEqual({ kind: "failed", error: refused });
    await job.pass(60_000);
    expect(job.asked).toHaveLength(2);
  });

  test("a failure that is no DataError ends it too, and is not tried again", async () => {
    const bug = new TypeError("x is undefined");
    const job = following(() => bug);
    await job.run;
    expect(job.result()).toEqual({ kind: "failed", error: bug });
  });

  test("aborting stops the asking, wherever it is", async () => {
    const job = following(() => aState());
    await job.pass(1500);
    expect(job.asked).toEqual([0, 1000]);
    job.aborter.abort();
    await job.run;
    expect(job.result()).toEqual({ kind: "aborted" });
    await job.pass(60_000);
    expect(job.asked).toEqual([0, 1000]);
  });

  test("aborting while it waits for the connection stops the asking too, and says nothing", async () => {
    const job = following(() => unanswered());
    await job.pass(1000);
    job.aborter.abort();
    await job.run;
    expect(job.result()).toEqual({ kind: "aborted" });
    await job.pass(60_000);
    expect(job.asked).toEqual([0]);
  });

  test("aborting during a question gives up on it, and says nothing", async () => {
    const job = following(() => new Promise<AssistState>(() => {}));
    await job.pass(0);
    job.aborter.abort();
    await job.run;
    expect(job.result()).toEqual({ kind: "aborted" });
    expect(job.told).toEqual([]);
    expect(job.waiting).toEqual([]);
  });

  test("a page that is left stops listening for the page to come back", async () => {
    const page = pageIs("hidden");
    const job = following(() => aState());
    await job.pass(0);
    job.aborter.abort();
    await job.run;
    page.shows();
    await job.pass(0);
    expect(job.asked).toEqual([0]);
  });
});

describe("what the panel shows of a job under way", () => {
  test("a model that has said nothing yet is waited for", () => {
    expect(progress(aState()).situation).toEqual({ kind: "waiting" });
  });

  test("a model that has reasoned and written nothing is thinking, and for how long", () => {
    expect(progress(aState({ thought: 1840 })).situation).toEqual({ kind: "thinking", thought: 1840 });
  });

  test("a model writing a field says which", () => {
    const shown = progress(aState({ written: 300, thought: 900, writing: "greeting", fields: ["name"] }));
    expect(shown.situation).toEqual({ kind: "writing", field: "greeting" });
  });

  test("a model between two fields, or at something that is not a field, is just writing", () => {
    expect(progress(aState({ written: 300, writing: null })).situation).toEqual({ kind: "between" });
  });

  test("the ten fields are there in the form's order, those that are complete told done", () => {
    const shown = progress(aState({ written: 900, fields: ["tagline", "name", "tags"], lore: 2, writing: "lore_entries" }));
    expect(shown.fields.map((f) => f.field)).toEqual([
      "name", "tagline", "description", "personality", "scenario", "greeting",
      "alternate_greetings", "example_dialogues", "tags", "lore_entries",
    ]);
    expect(shown.fields.filter((f) => f.done).map((f) => f.field)).toEqual(["name", "tagline", "tags"]);
    // Entries are counted while the book is still being written.
    expect(shown.lore).toBe(2);
  });

  test.each([
    [0, "0:00"], [0.9, "0:00"], [42.4, "0:42"], [60, "1:00"], [605, "10:05"], [-3, "0:00"],
  ])("%j seconds is %s on the clock", (seconds, shown) => {
    expect(formatClock(seconds)).toBe(shown);
  });
});

describe("what is said when a job has ended", () => {
  // Says which key and which values it was asked for, as the error tests do.
  const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
  const label = (field: string) => `<${field}>`;
  const said = (changes: Partial<AssistState>) =>
    describeOutcome(outcome(aState({ running: false, ...changes })), t, label);

  test("a whole card has nothing to say", () => {
    expect(said({ draft: { name: "Mira" } })).toBeNull();
  });

  test("missing fields are named, with the form's words for them", () => {
    expect(said({ draft: { name: "Mira" }, missing: ["greeting", "tags"] })).toBe(
      'characters.assist.missing {"fields":"<greeting>, <tags>"}',
    );
  });

  test("a card cut short says the model ran out of room, and one stopped says it was stopped", () => {
    expect(said({ cut: true, draft: { name: "Mira" }, missing: ["tags"] })).toBe(
      'characters.assist.missingCut {"fields":"<tags>"}',
    );
    expect(said({ stopped: true, draft: { name: "Mira" }, missing: ["tags"] })).toBe(
      'characters.assist.missingStopped {"fields":"<tags>"}',
    );
  });

  test("a failure with nothing kept is said alone", () => {
    const error = { error: "Thought only.", kind: "model_only_thought" };
    expect(said({ error })).toBe('errors.modelOnlyThought {"message":"Thought only."}');
  });

  test("a failure with some fields kept is said with what is missing", () => {
    const error = { error: "Reset.", kind: "model_connection_lost" };
    expect(said({ error, draft: { name: "Mira" }, missing: ["tagline"] })).toBe(
      'errors.modelNetworkError {"message":"Reset."} characters.assist.missing {"fields":"<tagline>"}',
    );
  });
});

describe("what the end of a job means for the form", () => {
  const card = {
    name: "Mira", tagline: "Keeper of the light", description: "Tired.", personality: "Dry.",
    scenario: "A storm.", greeting: "Come in.", alternate_greetings: ["Hello."], example_dialogues: "x",
    tags: ["sea"],
  };
  const book = [{ keys: ["lamp"], content: "It never goes out." }];

  test("a whole card gives all its fields and its lorebook entries, and has nothing to say", () => {
    const ended = outcome(aState({ running: false, draft: { ...card, lore_entries: book } }));
    expect(ended).toEqual({
      fields: card, lore: book, missing: [], cut: false, stopped: false, error: null,
    });
    expect(kept(ended)).toBe(true);
  });

  test("a card cut short gives what is complete, names what is missing, and says it was cut", () => {
    const ended = outcome(aState({
      running: false, cut: true, draft: { name: "Mira", tagline: "Keeper" }, missing: ["greeting", "tags"],
    }));
    expect(ended).toMatchObject({
      fields: { name: "Mira", tagline: "Keeper" }, lore: [], missing: ["greeting", "tags"], cut: true, stopped: false,
    });
  });

  test("a card stopped says so", () => {
    const ended = outcome(aState({ running: false, stopped: true, draft: { name: "Mira" }, missing: ["tagline"] }));
    expect(ended).toMatchObject({ fields: { name: "Mira" }, stopped: true, cut: false, missing: ["tagline"] });
  });

  test("a failure with fields kept gives both", () => {
    const error = { error: "Connection reset.", kind: "model_connection_lost" };
    const ended = outcome(aState({ running: false, draft: { name: "Mira" }, missing: ["tagline"], error }));
    expect(ended.error).toEqual(error);
    expect(ended.fields).toEqual({ name: "Mira" });
    expect(kept(ended)).toBe(true);
  });

  test("a failure with nothing kept gives the failure alone", () => {
    const error = { error: "The model only thought.", kind: "model_only_thought" };
    const ended = outcome(aState({ running: false, draft: null, error }));
    expect(ended).toEqual({ fields: {}, lore: [], missing: [], cut: false, stopped: false, error });
    expect(kept(ended)).toBe(false);
  });

  test("lorebook entries alone are something kept", () => {
    expect(kept(outcome(aState({ running: false, draft: { lore_entries: book } })))).toBe(true);
  });

  test("the lorebook is not among the fields to put over the form's", () => {
    expect(outcome(aState({ running: false, draft: { name: "Mira", lore_entries: book } })).fields).toEqual({ name: "Mira" });
  });
});
