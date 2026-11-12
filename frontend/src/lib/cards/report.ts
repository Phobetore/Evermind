import type { CardCharacter, CardText, LoreEntryInput } from "@/data";
import { pyStrip } from "@/engine/text";
import { bookEntries, cardFields, FIELDS, isObject, isStorable, texts } from "./read";

// What an import says it did with a card: what Evermind uses, and what it only keeps for the export.

export type ReportKey =
  | "greetings" | "lore" | "loreConstant" | "secondaryKeys" | "depthEntries" | "characterNote"
  | "postHistory" | "systemPrompt" | "examples" | "nickname"
  | "extensions" | "loreNotStored" | "outletEntries" | "otherPlaces" | "regexKeys" | "decorators"
  | "loreSettings" | "bookSettings" | "groupGreetings" | "assets" | "multilingualNotes"
  | "unreadFields" | "otherChunk";

export interface ReportLine { key: ReportKey; count?: number; names?: string[] }

export interface ImportReport {
  /** Read, kept in Evermind's fields, and used. */
  used: ReportLine[];
  /** Kept whole in the card for its export, not used. */
  kept: ReportLine[];
  /** The card says it is of a version newer than 3.0: read all the same. */
  newer: boolean;
}

/** The example dialogues as blocks: split on <START> whatever its case, the text before the first
 *  one a block too, each stripped, the empty ones left out. It is the rule the engine will follow
 *  when it sends the examples; once it does, its own split counts here and this copy goes. */
function exampleBlocks(examples: string): string[] {
  return examples.split(/<START>/i).map(pyStrip).filter(Boolean);
}

/** The entry settings SillyTavern honours and Evermind does not, in `extensions` but for the two
 *  that sit on the entry itself. `match_*` stands for every one but `match_whole_words`. */
const ENTRY_SETTINGS = [
  "probability", "useProbability", "group", "group_override", "group_weight", "use_group_scoring",
  "sticky", "cooldown", "delay", "scan_depth", "case_sensitive", "match_*", "triggers",
  "ignore_budget", "delay_until_recursion", "vectorized", "automation_id", "priority",
];
const BOOK_SETTINGS = ["scan_depth", "token_budget", "recursive_scanning"];

/** A setting that says something: not absent, nor null, false, 0, "" or []. */
const isSet = (value: unknown) =>
  value !== undefined && value !== null && value !== false && value !== 0 && value !== ""
  && !(Array.isArray(value) && value.length === 0);

/** A key is an expression only by its form: /…/ and its flags. */
function isRegexKey(key: string) {
  const end = key.lastIndexOf("/");
  return key.startsWith("/") && end > 1 && /^[a-z]*$/.test(key.slice(end + 1));
}

/** The settings of the list that some entry gives, in the list's order. */
function settingsOf(entries: Record<string, unknown>[]): string[] {
  const names: string[] = [];
  for (const name of ENTRY_SETTINGS) {
    for (const entry of entries) {
      const extensions = isObject(entry.extensions) ? entry.extensions : {};
      if (name === "match_*") {
        for (const key of Object.keys(extensions)) {
          if (key.startsWith("match_") && key !== "match_whole_words" && isSet(extensions[key]) && !names.includes(key)) names.push(key);
        }
        continue;
      }
      const value = name === "priority" ? entry.priority
        : name === "case_sensitive" && isSet(entry.case_sensitive) ? entry.case_sensitive : extensions[name];
      if (isSet(value) && !(name === "probability" && value === 100) && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

export function reportOf(card: Record<string, unknown>, character: CardCharacter, original: CardText): ImportReport {
  const fields = cardFields(card) ?? {};
  const extensions = isObject(fields.extensions) ? fields.extensions : {};
  const book = isObject(fields.character_book) ? fields.character_book : {};
  const raw = bookEntries(fields);
  // The entries the server will keep: the only ones a line about how entries behave speaks of.
  const stored = character.lore_entries.filter(isStorable);
  const count = (test: (entry: LoreEntryInput) => boolean) => stored.filter(test).length;
  const used: ReportLine[] = [];
  const kept: ReportLine[] = [];
  const say = (lines: ReportLine[], key: ReportKey, value: number | string[] | boolean) => {
    if (typeof value === "boolean") {
      if (value) lines.push({ key });
    } else if (typeof value === "number") {
      if (value > 0) lines.push({ key, count: value });
    } else if (value.length > 0) {
      lines.push({ key, names: value });
    }
  };

  say(used, "greetings", (character.greeting.trim() ? 1 : 0) + character.alternate_greetings.length);
  say(used, "lore", stored.length);
  say(used, "loreConstant", count((entry) => entry.constant));
  say(used, "secondaryKeys", count((entry) => entry.selective && entry.secondary_keys.length > 0));
  say(used, "depthEntries", count((entry) => entry.position === 4));
  // Its count is its depth, which may be 0: said whenever there is a note.
  if (character.character_note.trim()) used.push({ key: "characterNote", count: character.character_note_depth });
  say(used, "postHistory", Boolean(character.post_history_instructions.trim()));
  say(used, "systemPrompt", Boolean(character.system_prompt.trim()));
  say(used, "examples", exampleBlocks(character.example_dialogues).length);
  say(used, "nickname", Boolean(character.nickname.trim()));

  say(kept, "extensions", Object.keys(extensions).filter((key) => key !== "evermind" && key !== "depth_prompt"));
  say(kept, "loreNotStored", character.lore_entries.length - stored.length);
  say(kept, "outletEntries", count((entry) => entry.position === 7));
  say(kept, "otherPlaces", count((entry) => [2, 3, 5, 6].includes(entry.position)));
  say(kept, "regexKeys", count((entry) => entry.keys.some(isRegexKey)));
  say(kept, "decorators", count((entry) => entry.content.split("\n").some((line) => line.startsWith("@@"))));
  say(kept, "loreSettings", settingsOf(stored.map((entry) => raw[entry.origin!] as Record<string, unknown>)));
  say(kept, "bookSettings", BOOK_SETTINGS.filter((name) => book[name] !== undefined && book[name] !== null));
  say(kept, "groupGreetings", texts(fields.group_only_greetings).length);
  say(kept, "assets", Array.isArray(fields.assets) ? fields.assets.filter(isObject).length : 0);
  say(kept, "multilingualNotes", Object.keys(character.creator_notes_multilingual));
  say(kept, "unreadFields", [...Object.keys(FIELDS), "nickname"].filter((key) => {
    const value = fields[key];
    return value !== undefined && value !== null && typeof value !== "string" && typeof value !== "number";
  }));
  say(kept, "otherChunk", original.other_text !== null);

  return {
    used,
    kept,
    newer: card.spec === "chara_card_v3" && Number.parseFloat(String(card.spec_version)) > 3,
  };
}
