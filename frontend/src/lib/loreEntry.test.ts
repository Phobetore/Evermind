import { expect, test } from "vitest";
import { newLoreEntry } from "./loreEntry";

test("a new entry has the server's defaults", () => {
  // Written out here on purpose: these are the values of LoreEntryIn on the server.
  expect(newLoreEntry(["tide"], "It turns at noon.")).toEqual({
    keys: ["tide"],
    content: "It turns at noon.",
    enabled: true,
    origin: null,
    comment: "",
    constant: false,
    selective: false,
    secondary_keys: [],
    selective_logic: 0,
    insertion_order: 100,
    position: 1,
    depth: 4,
    role: "system",
    whole_words: true,
    exclude_recursion: false,
    prevent_recursion: false,
  });
});
