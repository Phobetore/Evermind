import { describe, expect, test } from "vitest";
import { oneQuestion, type Asked } from "./question";

type Options = { action: string };

/** The questions, and what has been put on screen, newest last. */
function asking() {
  const shown: (Asked<Options> | null)[] = [];
  const questions = oneQuestion<Options>((asked) => shown.push(asked));
  return { questions, shown, open: () => shown.at(-1) ?? null };
}

/** Whether a promise has settled yet, and with what. */
async function state<T>(promise: Promise<T>): Promise<{ settled: false } | { settled: true; value: T }> {
  const pending = Symbol();
  const value = await Promise.race([promise, Promise.resolve(pending)]);
  return value === pending ? { settled: false } : { settled: true, value: value as T };
}

describe("oneQuestion", () => {
  test("answers with what the person said, and takes the question off the screen", async () => {
    const { questions, open } = asking();
    const said = questions.ask("Delete it?", { action: "Delete" });
    expect(open()?.question).toBe("Delete it?");
    open()!.settle(true);
    expect(open()).toBeNull();
    expect(await said).toBe(true);
  });

  test("a question asked while one is open is a no, and leaves the open one", async () => {
    const { questions, open } = asking();
    const first = questions.ask("First?", { action: "Yes" });
    expect(await questions.ask("Second?", { action: "Yes" })).toBe(false);
    expect(open()?.question).toBe("First?");
    expect(await state(first)).toEqual({ settled: false });
  });

  test("dropped, the open question is a no", async () => {
    const { questions, open } = asking();
    const said = questions.ask("Delete it?", { action: "Delete" });
    questions.drop();
    expect(open()).toBeNull();
    expect(await said).toBe(false);
  });

  test("a late answer to a question settled already leaves the one asked since open", async () => {
    const { questions, open } = asking();
    const first = questions.ask("First?", { action: "Yes" });
    const late = open()!.settle;
    questions.drop();
    expect(await first).toBe(false);

    const second = questions.ask("Second?", { action: "Yes" });
    late(true);

    expect(open()?.question, "the late answer closed the question asked since").toBe("Second?");
    expect(await state(second), "the question asked since was answered by the first one's").toEqual({ settled: false });
    open()!.settle(true);
    expect(await second).toBe(true);
  });
});
