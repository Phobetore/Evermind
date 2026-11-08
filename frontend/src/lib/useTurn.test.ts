import { expect, test } from "vitest";
import { LiveText } from "./useTurn";

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
