import { afterEach, describe, expect, test, vi } from "vitest";
import type { Ai, ProbeModel, ProbeResult } from "@/types";
import {
  CHIPS,
  type FlowEvent,
  type FlowState,
  type Origin,
  footOf,
  have,
  initial,
  reduce,
  toCreate,
} from "./addFlow";

const SETTINGS: Origin = { from: "settings" };
const CONVERSATION: Origin = { from: "conversation", conversationId: "c1" };
const chip = (label: string) => CHIPS.find((c) => c.label === label)!;
const SAVED = { type: "service", id: "s1", provider: "openai-compatible", base_url: "https://openrouter.ai/api/v1" } as const;

function row(id: string, over: Partial<ProbeModel> = {}): ProbeModel {
  return {
    id,
    name: id,
    vendor: null,
    created: null,
    context: { served: null, configured: null, max: null },
    max_output: null,
    price: { input: null, output: null, varies: false, cache_read: null, cache_write: null },
    reasons: null,
    ...over,
  };
}

function list(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    family: "openrouter",
    local: false,
    read_at: "2026-11-24T12:00:00Z",
    service_id: null,
    dropped: { batch: 0 },
    models: [row("a/one"), row("b/two"), row("c/three")],
    ...over,
  };
}

const run = (state: FlowState, ...events: FlowEvent[]) => events.reduce(reduce, state);
const refused = { kind: "model_auth_refused", message: "OpenRouter refuses this key." };
const broken = { kind: "model_error", message: "The server failed." };

/** An online chip, its key, and the list. */
const listed = (origin: Origin = SETTINGS) =>
  run(initial(origin), { type: "chip", chip: chip("OpenRouter") }, { type: "key", key: "sk-typed" }, { type: "read", list: list() });

describe("the chips", () => {
  test("are the nine of the form before, local first, each with its address", () => {
    expect(CHIPS.map((c) => [c.label, c.base_url, c.local])).toEqual([
      ["Ollama", "http://localhost:11434/v1", true],
      ["LM Studio", "http://localhost:1234/v1", true],
      ["llama.cpp", "http://localhost:8080/v1", true],
      ["KoboldCpp", "http://localhost:5001/v1", true],
      ["OpenRouter", "https://openrouter.ai/api/v1", false],
      ["OpenAI", "https://api.openai.com/v1", false],
      ["Anthropic", "https://api.anthropic.com", false],
      ["Groq", "https://api.groq.com/openai/v1", false],
      ["Mistral", "https://api.mistral.ai/v1", false],
    ]);
    expect(CHIPS.filter((c) => c.provider === "anthropic").map((c) => c.family)).toEqual(["anthropic"]);
    expect(CHIPS.filter((c) => c.provider !== "openai-compatible")).toHaveLength(1);
  });
});

describe("each step leads to the next", () => {
  test("a saved service and a local chip are read at once; an online chip asks its key first", () => {
    expect(reduce(initial(SETTINGS), SAVED)).toMatchObject({ step: "reading", serviceId: "s1" });
    expect(reduce(initial(SETTINGS), { type: "chip", chip: chip("Ollama") })).toMatchObject({
      step: "reading",
      draft: { provider: "openai-compatible", base_url: "http://localhost:11434/v1", family: "ollama" },
    });
    const key = reduce(initial(SETTINGS), { type: "chip", chip: chip("OpenRouter") });
    expect(key).toMatchObject({ step: "key", draft: null });
    expect(reduce(key, { type: "key", key: "sk-typed" })).toMatchObject({
      step: "reading",
      draft: { provider: "openai-compatible", base_url: "https://openrouter.ai/api/v1", api_key: "sk-typed", family: "openrouter" },
    });
  });

  test("an empty key is no key to read with", () => {
    const key = reduce(initial(SETTINGS), { type: "chip", chip: chip("OpenRouter") });
    expect(reduce(key, { type: "key", key: "  " })).toBe(key);
  });

  test("another address is read with what was typed, with no family of its own", () => {
    const address = reduce(initial(SETTINGS), { type: "other" });
    expect(address.step).toBe("address");
    const reading = reduce(address, { type: "address", base_url: " http://192.168.1.5:8080/v1 ", key: "" });
    expect(reading).toMatchObject({ step: "reading", draft: { provider: "openai-compatible", base_url: "http://192.168.1.5:8080/v1", api_key: "" } });
    expect(reading.draft?.family).toBeUndefined();
  });

  test("a list read leads to the choice; an empty one is a failure", () => {
    const reading = reduce(initial(SETTINGS), { type: "chip", chip: chip("Ollama") });
    expect(reduce(reading, { type: "read", list: list() })).toMatchObject({ step: "pick", error: null });
    const empty = reduce(reading, { type: "read", list: list({ models: [] }) });
    expect(empty).toMatchObject({ step: "failed", list: null, error: { kind: "list_empty" } });
  });

  test("a failed read says why, and is asked again", () => {
    const reading = reduce(initial(SETTINGS), { type: "chip", chip: chip("Ollama") });
    const failed = reduce(reading, { type: "failed", error: broken });
    expect(failed).toMatchObject({ step: "failed", error: broken });
    expect(reduce(failed, { type: "retry" })).toMatchObject({ step: "reading", error: null });
  });

  test("a local chip is asked again at the address put right", () => {
    const failed = run(initial(SETTINGS), { type: "chip", chip: chip("Ollama") }, { type: "failed", error: broken });
    expect(reduce(failed, { type: "retry", base_url: "http://192.168.1.5:11434/v1" })).toMatchObject({
      step: "reading",
      draft: { base_url: "http://192.168.1.5:11434/v1", family: "ollama" },
    });
  });

  test("cancel goes back to the step before the read, with no failure", () => {
    const local = run(initial(SETTINGS), { type: "chip", chip: chip("Ollama") }, { type: "cancel" });
    expect(local).toEqual(initial(SETTINGS));
    const online = run(initial(SETTINGS), { type: "chip", chip: chip("OpenRouter") }, { type: "key", key: "sk-typed" }, { type: "cancel" });
    expect(online).toMatchObject({ step: "key", error: null, draft: { api_key: "sk-typed" } });
    const other = run(initial(SETTINGS), { type: "other" }, { type: "address", base_url: "http://h/v1", key: "" }, { type: "cancel" });
    expect(other).toMatchObject({ step: "address", error: null, draft: { base_url: "http://h/v1" } });
  });

  test("the name by hand opens the choice with no list, except under a refused key", () => {
    const failed = run(initial(SETTINGS), { type: "chip", chip: chip("Ollama") }, { type: "failed", error: broken });
    expect(reduce(failed, { type: "byHand" })).toMatchObject({ step: "pick", list: null, error: null });
    const empty = run(initial(SETTINGS), { type: "chip", chip: chip("Ollama") }, { type: "read", list: list({ models: [] }) });
    expect(reduce(empty, { type: "byHand" })).toMatchObject({ step: "pick", list: null });
    const locked = run(initial(SETTINGS), SAVED, { type: "failed", error: refused });
    expect(reduce(locked, { type: "byHand" })).toBe(locked);
  });

  test("a saved service whose key is refused takes a new one, for that service", () => {
    const locked = run(initial(SETTINGS), SAVED, { type: "failed", error: refused });
    const key = reduce(locked, { type: "newKey" });
    expect(key).toMatchObject({ step: "key", newKey: true, serviceId: "s1", error: null });
    expect(reduce(key, { type: "key", key: "sk-new" })).toMatchObject({
      step: "reading",
      draft: { id: "s1", provider: "openai-compatible", base_url: "https://openrouter.ai/api/v1", api_key: "sk-new" },
    });
    // Only a saved service, and only for a refused key.
    const chipRefused = run(initial(SETTINGS), { type: "chip", chip: chip("OpenRouter") }, { type: "key", key: "k" }, { type: "failed", error: refused });
    expect(reduce(chipRefused, { type: "newKey" })).toBe(chipRefused);
    const savedBroken = run(initial(SETTINGS), SAVED, { type: "failed", error: broken });
    expect(reduce(savedBroken, { type: "newKey" })).toBe(savedBroken);
  });
});

describe("the choice", () => {
  test("a tick is kept in the order made, and a second touch takes it off", () => {
    const state = run(listed(), { type: "pick", id: "b/two" }, { type: "pick", id: "a/one" }, { type: "pick", id: "c/three" });
    expect(state.picked).toEqual(["b/two", "a/one", "c/three"]);
    expect(reduce(state, { type: "pick", id: "a/one" }).picked).toEqual(["b/two", "c/three"]);
  });

  test("a name used as it is becomes a row on top, ticked; one the list has is only ticked", () => {
    const state = run(listed(), { type: "useAsIs", id: " zz-absent " }, { type: "useAsIs", id: "x-other" });
    expect(state.typed).toEqual(["x-other", "zz-absent"]);
    expect(state.picked).toEqual(["zz-absent", "x-other"]);
    const known = reduce(listed(), { type: "useAsIs", id: "b/two" });
    expect(known.typed).toEqual([]);
    expect(known.picked).toEqual(["b/two"]);
  });

  test("answers are kept by model", () => {
    const state = run(
      listed(),
      { type: "answer", id: "a/one", answer: { context_own: 32_000 } },
      { type: "answer", id: "a/one", answer: { price_own_in: 3 } },
    );
    expect(state.answers["a/one"]).toEqual({ context_own: 32_000, price_own_in: 3 });
  });

  test("a read again that fails keeps the list, the ticks and the answers on screen", () => {
    const ticked = run(listed(), { type: "pick", id: "a/one" }, { type: "answer", id: "a/one", answer: { context_own: 8_000 } });
    const failed = reduce(ticked, { type: "failed", error: broken });
    expect(failed).toMatchObject({ step: "pick", list: ticked.list, picked: ["a/one"], error: broken });
    expect(failed.answers).toEqual(ticked.answers);
    const again = reduce(failed, { type: "read", list: list({ models: [row("a/one"), row("d/four")] }) });
    expect(again).toMatchObject({ step: "pick", picked: ["a/one"], error: null });
    expect(again.list?.models.map((m) => m.id)).toEqual(["a/one", "d/four"]);
  });

  test("adding marks the foot as sent, and a second press changes nothing", () => {
    const ticked = reduce(listed(), { type: "pick", id: "a/one" });
    const adding = reduce(ticked, { type: "adding" });
    expect(adding.pending).toBe(true);
    expect(reduce(adding, { type: "adding" })).toBe(adding);
    expect(reduce(listed(), { type: "adding" }).pending).toBe(false);
  });

  test("an add that fails stays on the list with its ticks; one that works is done", () => {
    const adding = run(listed(), { type: "pick", id: "a/one" }, { type: "adding" });
    const failed = reduce(adding, { type: "addFailed", error: broken });
    expect(failed).toMatchObject({ step: "pick", pending: false, picked: ["a/one"], addError: broken });
    expect(reduce(adding, { type: "added" })).toMatchObject({ step: "done", pending: false });
  });

  test("after a new key and a read, with nothing ticked, the foot offers to save the key", () => {
    const read = run(
      initial(SETTINGS),
      SAVED,
      { type: "failed", error: refused },
      { type: "newKey" },
      { type: "key", key: "sk-new" },
      { type: "read", list: list({ service_id: null }) },
    );
    expect(footOf(read)).toEqual({ kind: "saveKey" });
    const saving = reduce(read, { type: "adding" });
    expect(saving.pending).toBe(true);
    const saved = reduce(saving, { type: "keySaved" });
    expect(saved).toMatchObject({ keySaved: true, pending: false, step: "pick" });
    expect(footOf(saved)).toEqual({ kind: "tick" });
    expect(footOf(reduce(saved, { type: "pick", id: "a/one" }))).toEqual({ kind: "add", count: 1 });
  });

  test("the foot says what a press does", () => {
    expect(footOf(listed())).toEqual({ kind: "tick" });
    expect(footOf(run(listed(), { type: "pick", id: "a/one" }, { type: "pick", id: "b/two" }))).toEqual({ kind: "add", count: 2 });
    const here = run(listed(CONVERSATION), { type: "pick", id: "a/one" }, { type: "pick", id: "b/two" });
    expect(footOf(here)).toEqual({ kind: "answer", count: 2, last: "b/two" });
    expect(footOf(reduce(here, { type: "pick", id: "b/two" }))).toEqual({ kind: "answer", count: 1, last: "a/one" });
  });
});

describe("back", () => {
  test("from each step", () => {
    const where = initial(SETTINGS);
    expect(reduce(where, { type: "back" })).toEqual(where);
    expect(run(where, { type: "chip", chip: chip("OpenRouter") }, { type: "back" })).toEqual(where);
    expect(run(where, { type: "other" }, { type: "back" })).toEqual(where);
    // The choice of a saved service, of a local chip, of another address: where.
    expect(run(where, SAVED, { type: "read", list: list() }, { type: "back" })).toEqual(where);
    expect(run(where, { type: "chip", chip: chip("Ollama") }, { type: "read", list: list() }, { type: "back" })).toEqual(where);
    expect(run(where, { type: "other" }, { type: "address", base_url: "http://h/v1", key: "" }, { type: "read", list: list() }, { type: "back" })).toEqual(where);
    // The choice of a service with a key just typed: that key.
    expect(reduce(listed(), { type: "back" })).toMatchObject({ step: "key", list: null, picked: [], draft: { api_key: "sk-typed" } });
    // A failure: where.
    expect(run(where, { type: "chip", chip: chip("Ollama") }, { type: "failed", error: broken }, { type: "back" })).toEqual(where);
    // Reading: as cancel.
    expect(run(where, { type: "chip", chip: chip("Ollama") }, { type: "back" })).toEqual(where);
  });

  test("from the key asked again, and from the name by hand: the failure they came from", () => {
    const locked = run(initial(SETTINGS), SAVED, { type: "failed", error: refused });
    expect(run(locked, { type: "newKey" }, { type: "back" })).toMatchObject({ step: "failed", error: refused, newKey: false });
    const failed = run(initial(SETTINGS), { type: "chip", chip: chip("Ollama") }, { type: "failed", error: broken });
    expect(run(failed, { type: "byHand" }, { type: "useAsIs", id: "mine" }, { type: "back" })).toMatchObject({
      step: "failed",
      error: broken,
      typed: [],
      picked: [],
    });
  });

  test("from the list of a key asked again: that key, then the failure", () => {
    const read = run(
      initial(SETTINGS),
      SAVED,
      { type: "failed", error: refused },
      { type: "newKey" },
      { type: "key", key: "sk-new" },
      { type: "read", list: list() },
    );
    const key = reduce(read, { type: "back" });
    expect(key).toMatchObject({ step: "key", newKey: true });
    expect(reduce(key, { type: "back" })).toMatchObject({ step: "failed", error: refused });
  });
});

describe("what is sent", () => {
  test("a name used as it is goes without a read; a row of the list with it", () => {
    const state = run(listed(), { type: "pick", id: "a/one" }, { type: "useAsIs", id: "zz-absent" });
    expect(toCreate(state)).toEqual({
      service: { provider: "openai-compatible", base_url: "https://openrouter.ai/api/v1", api_key: "sk-typed", family: "openrouter" },
      models: [{ model: "a/one", read: row("a/one") }, { model: "zz-absent" }],
    });
  });

  test("the answers go with their model, and a conversation is named", () => {
    const state = run(
      listed(CONVERSATION),
      { type: "pick", id: "a/one" },
      { type: "answer", id: "a/one", answer: { context_own: null, price_own_in: 3, price_own_out: 15 } },
    );
    expect(toCreate(state)).toMatchObject({
      models: [{ model: "a/one", context_own: null, price_own_in: 3, price_own_out: 15 }],
      conversation_id: "c1",
    });
  });

  test("another address whose read found Ollama is sent as Ollama", () => {
    const state = run(
      initial(SETTINGS),
      { type: "other" },
      { type: "address", base_url: "http://192.168.1.5:11434/v1", key: "" },
      { type: "read", list: list({ family: "ollama", local: true }) },
      { type: "pick", id: "a/one" },
    );
    expect(toCreate(state).service).toEqual({ provider: "openai-compatible", base_url: "http://192.168.1.5:11434/v1", api_key: "", family: "ollama" });
  });

  test("a saved service is named by its id, with no key; after a new key, a draft with its id and the key", () => {
    const saved = run(initial(SETTINGS), SAVED, { type: "read", list: list({ service_id: "s1" }) }, { type: "pick", id: "a/one" });
    expect(toCreate(saved).service).toEqual({ id: "s1", family: "openrouter" });
    const renewed = run(
      initial(SETTINGS),
      SAVED,
      { type: "failed", error: refused },
      { type: "newKey" },
      { type: "key", key: "sk-new" },
      { type: "read", list: list() },
      { type: "pick", id: "a/one" },
    );
    expect(toCreate(renewed).service).toEqual({
      id: "s1", provider: "openai-compatible", base_url: "https://openrouter.ai/api/v1", api_key: "sk-new", family: "openrouter",
    });
  });

  test("a name by hand goes with the chip's family, or none", () => {
    const local = run(initial(SETTINGS), { type: "chip", chip: chip("LM Studio") }, { type: "failed", error: broken }, { type: "byHand" }, { type: "useAsIs", id: "qwen" });
    expect(toCreate(local)).toEqual({
      service: { provider: "openai-compatible", base_url: "http://localhost:1234/v1", family: "lmstudio" },
      models: [{ model: "qwen" }],
    });
    const other = run(initial(SETTINGS), { type: "other" }, { type: "address", base_url: "http://proxy/v1", key: "k" }, { type: "failed", error: broken }, { type: "byHand" }, { type: "useAsIs", id: "m" });
    expect(toCreate(other).service).toEqual({ provider: "openai-compatible", base_url: "http://proxy/v1", api_key: "k" });
  });
});

describe("what is already there", () => {
  const ai = (id: string, service: string, model: string) => ({ id, model, service: { id: service } }) as unknown as Ai;
  const ais = [ai("m1", "s1", "a/one"), ai("m2", "s2", "b/two"), ai("m3", "s1", "c/three")];

  test("the models of the service the list is of", () => {
    expect(have(listed(), ais)).toEqual(new Set());
    const read = run(initial(SETTINGS), { type: "chip", chip: chip("OpenRouter") }, { type: "key", key: "k" }, { type: "read", list: list({ service_id: "s1" }) });
    expect(have(read, ais)).toEqual(new Set(["a/one", "c/three"]));
  });

  test("a key typed again for a saved service still marks its models", () => {
    const read = run(
      initial(SETTINGS),
      SAVED,
      { type: "failed", error: refused },
      { type: "newKey" },
      { type: "key", key: "sk-new" },
      { type: "read", list: list({ service_id: null }) },
    );
    expect(have(read, ais)).toEqual(new Set(["a/one", "c/three"]));
  });
});

describe("closing", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("at any step leaves nothing to write: nothing is kept anywhere but in the state", () => {
    const kept: string[] = [];
    const storage = { setItem: (key: string, value: string) => kept.push(key, value), getItem: () => null, removeItem: () => {} };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);
    const steps = [
      initial(SETTINGS),
      reduce(initial(SETTINGS), { type: "chip", chip: chip("OpenRouter") }),
      run(initial(SETTINGS), { type: "chip", chip: chip("OpenRouter") }, { type: "key", key: "sk-secret" }),
      run(listed(), { type: "pick", id: "a/one" }),
      run(listed(), { type: "pick", id: "a/one" }, { type: "failed", error: broken }),
      run(initial(SETTINGS), { type: "other" }, { type: "address", base_url: "http://h/v1", key: "sk-secret" }, { type: "failed", error: broken }),
    ];
    expect(steps.map((s) => s.step)).toEqual(["where", "key", "reading", "pick", "pick", "failed"]);
    expect(kept).toEqual([]);
  });
});
