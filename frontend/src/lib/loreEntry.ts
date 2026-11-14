import type { LoreEntryInput } from "@/data";

/** What a lorebook entry made here starts as: the same values the server gives one that arrives
 *  without them, so an entry looks the same whichever side made it. */
export const NEW_LORE_ENTRY: Omit<LoreEntryInput, "keys" | "content"> = {
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
};

export function newLoreEntry(keys: string[], content: string): LoreEntryInput {
  // The list is copied: two entries must not share the one array.
  return { ...NEW_LORE_ENTRY, secondary_keys: [], keys, content };
}
