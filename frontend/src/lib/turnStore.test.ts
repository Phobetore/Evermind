import { beforeEach, describe, expect, test, vi } from "vitest";

const { stop } = vi.hoisted(() => ({ stop: vi.fn() }));
vi.mock("@/data", () => ({ data: { turns: { stop } } }));

import { turnStore } from "./turnStore";

let conversation = 0;
/** The store is the module's, so each test has a conversation of its own. */
const nextId = () => `conversation-${(conversation += 1)}`;

function reading(id = nextId()) {
  const reader = new AbortController();
  turnStore.begin(id, reader);
  return { id, reader };
}

beforeEach(() => {
  stop.mockReset();
  stop.mockResolvedValue(undefined);
});

describe("a turn read again from its first word", () => {
  test("what is on screen does not go backwards while the replay catches up", () => {
    const { id, reader } = reading();
    turnStore.append(id, reader, "one two three");

    const next = new AbortController();
    turnStore.handOver(id, next);
    turnStore.restart(id, next);
    expect(turnStore.read(id)?.text).toBe("one two three");

    turnStore.append(id, next, "one ");
    expect(turnStore.read(id)?.text).toBe("one two three");
    turnStore.append(id, next, "two three");
    expect(turnStore.read(id)?.text).toBe("one two three");
    turnStore.append(id, next, " four");
    expect(turnStore.read(id)?.text).toBe("one two three four");
  });

  test("a turn being read from nothing shows its words as they come", () => {
    const { id, reader } = reading();
    turnStore.restart(id, reader);
    turnStore.append(id, reader, "one");
    expect(turnStore.read(id)?.text).toBe("one");
  });
});

describe("readers that end with the turn unfinished", () => {
  test("are counted in a row until there is a new word to show for it", () => {
    const { id, reader } = reading();
    turnStore.append(id, reader, "one");
    expect(turnStore.closedEarly(id, reader)).toBe(1);
    expect(turnStore.closedEarly(id, reader)).toBe(2);
    expect(turnStore.closedEarly(id, reader)).toBe(3);
    turnStore.append(id, reader, " two");
    expect(turnStore.closedEarly(id, reader)).toBe(1);
  });

  test("a replay that has not caught up is no new word", () => {
    const { id, reader } = reading();
    turnStore.append(id, reader, "one two");
    expect(turnStore.closedEarly(id, reader)).toBe(1);
    const next = new AbortController();
    turnStore.handOver(id, next);
    turnStore.restart(id, next);
    turnStore.append(id, next, "one");
    expect(turnStore.closedEarly(id, next)).toBe(2);
  });

  test("the count starts again after the connection was lost", () => {
    const { id, reader } = reading();
    turnStore.append(id, reader, "one");
    turnStore.closedEarly(id, reader);
    turnStore.closedEarly(id, reader);
    turnStore.lose(id, reader, new Error("gone"));

    const next = new AbortController();
    turnStore.handOver(id, next);
    expect(turnStore.closedEarly(id, next)).toBe(1);
  });
});

describe("a reader that has been replaced", () => {
  function replaced() {
    const { id, reader } = reading();
    turnStore.append(id, reader, "one");
    const next = new AbortController();
    turnStore.handOver(id, next);
    return { id, old: reader, next };
  }

  test("is stopped", () => {
    expect(replaced().old.signal.aborted).toBe(true);
  });

  test("adds no words", () => {
    const { id, old } = replaced();
    turnStore.append(id, old, " late");
    expect(turnStore.read(id)?.text).toBe("one");
  });

  test("cannot end, lose or drop the turn", () => {
    const { id, old, next } = replaced();
    expect(turnStore.end(id, old)).toBe(false);
    turnStore.lose(id, old, new Error("gone"));
    turnStore.drop(id, old);
    expect(turnStore.read(id)).toMatchObject({ busy: true, lost: null });
    expect(turnStore.readerOf(id)).toBe(next);
  });

  test("counts for nothing", () => {
    const { id, old, next } = replaced();
    expect(turnStore.closedEarly(id, old)).toBe(0);
    expect(turnStore.closedEarly(id, next)).toBe(1);
  });
});

describe("two conversations", () => {
  test("keep their own words, readers and reports", () => {
    const a = reading();
    const b = reading();
    turnStore.append(a.id, a.reader, "alpha");
    turnStore.append(b.id, b.reader, "bravo");
    expect(turnStore.read(a.id)?.text).toBe("alpha");
    expect(turnStore.read(b.id)?.text).toBe("bravo");
    expect(a.reader.signal.aborted).toBe(false);

    turnStore.fail(a.id, "no reply");
    expect(turnStore.failureOf(b.id)).toBeNull();
  });

  test("a reader cannot write into the other", () => {
    const a = reading();
    const b = reading();
    turnStore.append(b.id, a.reader, "alpha");
    expect(turnStore.read(b.id)?.text).toBe("");
  });

  test("a connection lost in one leaves the other as it is", () => {
    const a = reading();
    const b = reading();
    turnStore.lose(a.id, a.reader, new Error("gone"));
    expect(turnStore.isRunning(a.id)).toBe(false);
    expect(turnStore.isRunning(b.id)).toBe(true);
    expect(b.reader.signal.aborted).toBe(false);
  });

  test("a new reader for one is no business of the other's", () => {
    const a = reading();
    const b = reading();
    turnStore.handOver(a.id, new AbortController());
    expect(b.reader.signal.aborted).toBe(false);
    expect(turnStore.readerOf(b.id)).toBe(b.reader);
  });
});

describe("a turn that has lost its connection", () => {
  test("keeps its words, stops receiving and lets the reader go", () => {
    const { id, reader } = reading();
    turnStore.append(id, reader, "one");
    const why = new Error("gone");
    turnStore.lose(id, reader, why);
    expect(turnStore.read(id)).toMatchObject({ text: "one", busy: false, lost: why });
    expect(reader.signal.aborted).toBe(true);
    expect(turnStore.end(id, reader), "it is not over as far as anyone knows").toBe(false);
  });

  test("comes back with a new reader, words and all", () => {
    const { id, reader } = reading();
    turnStore.append(id, reader, "one");
    turnStore.lose(id, reader, new Error("gone"));
    turnStore.handOver(id, new AbortController());
    expect(turnStore.read(id)).toMatchObject({ text: "one", busy: true, lost: null });
  });
});

describe("stopping", () => {
  test("says so to the server, and stops the reader", () => {
    const { id, reader } = reading();
    turnStore.stop(id);
    expect(stop).toHaveBeenCalledWith(id);
    expect(reader.signal.aborted).toBe(true);
    expect(turnStore.isStopping(id)).toBe(true);
  });

  test("a stop that could not be said is reported, and said again", async () => {
    const { id } = reading();
    const down = new Error("gone");
    stop.mockRejectedValueOnce(down);
    turnStore.stop(id);
    await vi.waitFor(() => expect(turnStore.failureOf(id)).toEqual({ error: down }));

    stop.mockRejectedValueOnce(down);
    await expect(turnStore.sayStopAgain(id)).resolves.toBe(false);
    expect(turnStore.failureOf(id)).toEqual({ error: down });

    await expect(turnStore.sayStopAgain(id)).resolves.toBe(true);
    expect(turnStore.failureOf(id)).toBeNull();
    stop.mockClear();
    await expect(turnStore.sayStopAgain(id), "said, so nothing left to say").resolves.toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  test("a stop left unsaid does not land on the next turn", async () => {
    const { id } = reading();
    stop.mockRejectedValueOnce(new Error("gone"));
    turnStore.stop(id);
    await vi.waitFor(() => expect(turnStore.failureOf(id)).not.toBeNull());

    turnStore.begin(id, new AbortController());
    stop.mockClear();
    await expect(turnStore.sayStopAgain(id)).resolves.toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });
});

test("the same object until something changes, which is what useSyncExternalStore needs", () => {
  const { id, reader } = reading();
  const first = turnStore.read(id);
  expect(turnStore.read(id)).toBe(first);
  turnStore.append(id, reader, "one");
  expect(turnStore.read(id)).not.toBe(first);
});
