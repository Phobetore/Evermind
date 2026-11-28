import { expect, test } from "vitest";
import type { Outlook, TurnState } from "@/types";
import { endOf, LiveText } from "./useTurn";

test("what a model thinks before its reply is not shown, nor the tag that opens it while it arrives", () => {
  const words = new LiveText();
  words.set("<thi");
  expect(words.get()).toBe("");
  words.add("nk>The player wants");
  expect(words.get()).toBe("");
  words.add(" the door.</think>\n\nThe door opens.");
  expect(words.get()).toBe("The door opens.");
  // Kept, as the server keeps it in the reply it saves.
  words.add(" <think>Again");
  expect(words.get()).toBe("The door opens. <think>Again");
  words.set("<3");
  expect(words.get()).toBe("<3");
});

const glance = { way: { name: "Immersive" } } as unknown as Outlook["current"];
const spent = { total: 0.0021, currency: "USD", calls: 1, unpriced_calls: 0, free: false };
const ended = { running: false, outcome: null, revision: 4, glance, spent } satisfies TurnState;

test("a turn seen from start to end hands the page what its end carries", () => {
  expect(endOf(ended, true)).toEqual({ glance, spent });
});

test("a turn found over, as the page opens or its answer lost, hands nothing: the page reads", () => {
  expect(endOf(ended, false)).toEqual({ glance: null, spent: null });
  // A server that carries nothing at its end, as the browser edition.
  expect(endOf({ running: false, outcome: null, revision: 4 }, true)).toEqual({ glance: null, spent: null });
});
