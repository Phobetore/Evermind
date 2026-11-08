import { expect, test } from "vitest";
import { LiveText } from "./useTurn";

test("what a model thinks in its reply is not shown, nor what it is still thinking", () => {
  const words = new LiveText();
  words.set("<think>The player wants");
  expect(words.get()).toBe("");
  words.add(" the door.</think>\n\nThe door opens.");
  expect(words.get()).toBe("The door opens.");
  words.add(" <think>Again");
  expect(words.get()).toBe("The door opens. ");
});
