import { describe, expect, test } from "vitest";
import { addTag } from "./tags";

describe("a tag typed in", () => {
  test("is added as it was typed, without the spaces around it", () => {
    expect(addTag(["noir"], "  Fantasy ")).toEqual(["noir", "Fantasy"]);
  });

  test.each(["fantasy", "FANTASY", " Fantasy  "])(
    "that the list has in another case or spacing (%j) is not added again, and the list keeps its own spelling",
    (typed) => {
      expect(addTag(["Fantasy", "noir"], typed)).toEqual(["Fantasy", "noir"]);
    },
  );

  test("that is only spaces adds nothing", () => {
    expect(addTag(["noir"], "   ")).toEqual(["noir"]);
  });
});
