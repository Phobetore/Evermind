import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { CardCharacter, LoreEntryInput } from "@/data";
import { readCardFile } from "./index";
import { readCardJson } from "./read";

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
const readText = (text: string) => readCardJson(JSON.parse(text), text, "json")!;
const readFixture = (name: string) => readText(fixture(name));
const readObject = (card: object) => readCardJson(card, JSON.stringify(card), "json")!;
/** A V2 card of these fields, with these entries in its book. */
const v2 = (data: object, entries?: unknown[]) =>
  readObject({ spec: "chara_card_v2", spec_version: "2.0", data: { name: "N", ...data, ...(entries && { character_book: { entries } }) } });

const WHOLE = 2 ** 53 - 1;

/** What the server's LoreEntryIn and CharacterIn take, as models/schemas.py bounds them: a reading
 *  that passes here is not refused with a 422. */
function acceptedByTheServer(character: CardCharacter) {
  const within = (value: number, low: number, high: number) => Number.isInteger(value) && value >= low && value <= high;
  const roles = ["system", "user", "assistant"];
  expect(within(character.character_note_depth, 0, WHOLE)).toBe(true);
  expect(roles).toContain(character.character_note_role);
  for (const entry of character.lore_entries) {
    expect(entry.origin === null || within(entry.origin, 0, WHOLE)).toBe(true);
    expect(within(entry.selective_logic, 0, 3)).toBe(true);
    expect(within(entry.insertion_order, -WHOLE, WHOLE)).toBe(true);
    expect(within(entry.position, 0, 7)).toBe(true);
    expect(within(entry.depth, 0, WHOLE)).toBe(true);
    expect(roles).toContain(entry.role);
    for (const name of ["enabled", "constant", "selective", "whole_words", "exclude_recursion", "prevent_recursion"] as const) {
      expect(typeof entry[name]).toBe("boolean");
    }
  }
}

describe("the entries of a card", () => {
  test("every entry of the card is read, with its index there", () => {
    const { character } = v2({}, [1, { keys: ["a"], content: "A." }, { keys: [], content: "" }]);
    expect(character.lore_entries).toHaveLength(2);
    expect(character.lore_entries.map((entry) => entry.origin)).toEqual([1, 2]);
  });

  test("an always-on entry without a keyword is kept", () => {
    const { character } = v2({}, [{ keys: [], content: "Always.", constant: true }]);
    expect(character.lore_entries).toEqual([expect.objectContaining({ keys: [], content: "Always.", constant: true, origin: 0 })]);
  });

  test("a keyword is stripped as the server strips it", () => {
    // Python's strip keeps a byte order mark and takes U+001F and U+0085, where JavaScript's trim does the opposite.
    const { character } = v2({}, [{ keys: ["\uFEFF", " \u001Fa\u0085 ", "  ", 7, null], secondary_keys: ["\uFEFF"], content: "A." }]);
    expect(character.lore_entries[0]).toMatchObject({ keys: ["\uFEFF", "a", "7"], secondary_keys: ["\uFEFF"] });
  });

  test("the settings are read where SillyTavern writes them", () => {
    const { character } = readFixture("sillytavern-export.json");
    const entries: Partial<LoreEntryInput>[] = [
      {
        keys: ["lamp", "light"], content: "The lamp burns whale oil and is trimmed at dusk.", enabled: true, origin: 0,
        comment: "The lamp", constant: false, selective: true, secondary_keys: [], selective_logic: 0,
        insertion_order: 100, position: 1, depth: 4, role: "system", whole_words: true,
        exclude_recursion: false, prevent_recursion: false,
      },
      {
        keys: ["storm"], content: "Storms here come from the west, at night.", enabled: true, origin: 1,
        comment: "", constant: false, selective: true, secondary_keys: ["night", "dark"], selective_logic: 3,
        insertion_order: 120, position: 4, depth: 1, role: "user", whole_words: false,
        exclude_recursion: false, prevent_recursion: true,
      },
      {
        keys: [], content: "The lighthouse stands on a bare rock, a mile from shore.", enabled: true, origin: 2,
        comment: "The rock", constant: true, selective: false, secondary_keys: [], selective_logic: 0,
        insertion_order: 50, position: 0, depth: 4, role: "assistant", whole_words: true,
        exclude_recursion: true, prevent_recursion: false,
      },
      {
        keys: ["log"], content: "The keeper's log, read aloud.", enabled: false, origin: 3,
        comment: "", constant: false, selective: false, secondary_keys: [], selective_logic: 0,
        insertion_order: 100, position: 7, depth: 4, role: "system", whole_words: true,
        exclude_recursion: false, prevent_recursion: false,
      },
    ];
    expect(character.lore_entries).toEqual(entries);
    expect(character).toMatchObject({
      description: "A lighthouse keeper on a rock in the north sea.",
      creator_notes: "Keeper of the light. Written by hand for the tests.",
      character_note: "Mirelle never leaves the lamp unattended.", character_note_depth: 2, character_note_role: "system",
      card_rules: 2,
    });
  });

  test("the underscore spelling wins over the other, and root-level settings are ignored", () => {
    const [harbor] = readFixture("chub-v2.json").character.lore_entries;
    // excludeRecursion: true and exclude_recursion: false; probability and selectiveLogic at the root;
    // a position "0" that is neither of the two words.
    expect(harbor).toMatchObject({ exclude_recursion: false, selective_logic: 1, position: 1, origin: 0 });
  });

  test("a position written as a word or a digit string reads, a malformed one falls back", () => {
    const { character } = v2({}, [
      { keys: ["a"], content: "A.", extensions: { position: "0" } },
      { keys: ["b"], content: "B.", position: "before_char" },
      { keys: ["c"], content: "C.", position: "before_char", extensions: { position: 9 } },
      { keys: ["d"], content: "D.", position: "after_char", extensions: { position: "12" } },
      { keys: ["e"], content: "E.", position: "0" },
    ]);
    expect(character.lore_entries.map((entry) => entry.position)).toEqual([0, 0, 0, 1, 1]);
  });

  test("a malformed setting falls back, and the card imports", () => {
    const bad = [-1, 2.5, "abc", 1e300, "1234567890123456789012345", null];
    const { character } = v2(
      { extensions: { depth_prompt: { prompt: "Note.", depth: -1, role: "narrator" } } },
      [
        ...bad.map((depth) => ({ keys: ["k"], content: "c", extensions: { depth } })),
        { keys: ["k"], content: "c", insertion_order: 1e300, extensions: { role: "narrator", selectiveLogic: 7, position: -3 } },
        { keys: ["k"], content: "c", insertion_order: "-12", extensions: { depth: "7", role: 2, selectiveLogic: 2 } },
      ],
    );
    expect(character.lore_entries.slice(0, bad.length).map((entry) => entry.depth)).toEqual(bad.map(() => 4));
    expect(character.lore_entries[bad.length]).toMatchObject({ insertion_order: 100, role: "system", selective_logic: 0, position: 1 });
    expect(character.lore_entries[bad.length + 1]).toMatchObject({ insertion_order: -12, depth: 7, role: "assistant", selective_logic: 2 });
    expect(character).toMatchObject({ character_note_depth: 4, character_note_role: "system" });
    for (const depth of bad) {
      expect(v2({ extensions: { depth_prompt: { prompt: "Note.", depth } } }).character.character_note_depth).toBe(4);
    }
    acceptedByTheServer(character);
  });

  test("whole words are on unless the card turns them off", () => {
    const { character } = v2({}, [
      { keys: ["a"], content: "A." },
      { keys: ["b"], content: "B.", extensions: { match_whole_words: null } },
      { keys: ["c"], content: "C.", extensions: { match_whole_words: false } },
      { keys: ["d"], content: "D.", extensions: { match_whole_words: true } },
      { keys: ["e"], content: "E.", extensions: { matchWholeWords: false } },
    ]);
    expect(character.lore_entries.map((entry) => entry.whole_words)).toEqual([true, true, false, true, true]);
  });
});

describe("the fields of a card", () => {
  test("the character's note is read with its depth and role", () => {
    expect(readFixture("chub-v2.json").character).toMatchObject({
      character_note: "{{char}} counts every crate.", character_note_depth: 6, character_note_role: "user",
    });
    const note = (role: unknown) => v2({ extensions: { depth_prompt: { prompt: "P", depth: 0, role } } }).character;
    expect(note("assistant")).toMatchObject({ character_note: "P", character_note_depth: 0, character_note_role: "assistant" });
    expect(note(0).character_note_role).toBe("system");
    expect(note(2).character_note_role).toBe("assistant");
    expect(v2({}).character).toMatchObject({ character_note: "", character_note_depth: 4, character_note_role: "system" });
  });

  test("a flat Pygmalion card reads", () => {
    expect(readFixture("pygmalion-flat.json").character).toMatchObject({
      name: "Bellamy",
      description: "A retired sea captain who tells long stories.",
      greeting: "Sit down, sit down. Have I told you about the whale?",
      scenario: "A tavern by the docks.",
      example_dialogues: "You: Tell me about the whale.\nBellamy: It was as big as a church.",
      card_rules: 2,
    });
  });

  test("a flat V1 card reads its creatorcomment as its creator notes", () => {
    expect(readObject({ name: "Vane", creatorcomment: "Written in a hurry." }).character.creator_notes).toBe("Written in a hurry.");
    expect(readObject({ name: "Vane", creator_notes: "Mine.", creatorcomment: "Theirs." }).character.creator_notes).toBe("Mine.");
    // A V2 card reads its own notes, not the copy SillyTavern puts at the root.
    expect(readObject({ spec: "chara_card_v2", creatorcomment: "Root.", data: { name: "Vane" } }).character.creator_notes).toBe("");
  });

  test("tags lose their duplicates and blanks, the first spelling kept", () => {
    expect(v2({ tags: [" Sea ", "sea", "", "  ", "SEA", "Storm", "storm "] }).character.tags).toEqual(["Sea", "Storm"]);
  });

  test("the nickname and the notes by language are read", () => {
    expect(readFixture("risu-v3.json").character).toMatchObject({
      nickname: "Ari", creator_notes_multilingual: { en: "A guardian.", ko: "문지기." },
    });
    expect(readFixture("risu-v3.json").character.creator_notes_multilingual).not.toHaveProperty("fr");
    // Cut where the name is cut, counted the same way; an empty one stays empty.
    expect(v2({ nickname: "😀".repeat(250) }).character.nickname).toBe("😀".repeat(200));
    expect(v2({ nickname: "" }).character.nickname).toBe("");
  });

  test("a flat V1 card with a data object of its own reads by its root", () => {
    expect(readObject({ name: "Vane", first_mes: "Late.", data: { source: "a site" } }).character)
      .toMatchObject({ name: "Vane", greeting: "Late." });
    // Without spec, data that holds a field of a card is the card.
    expect(readObject({ data: { name: "Inner" } }).character.name).toBe("Inner");
    expect(readCardJson({ data: {} }, "{}", "json")).toBeNull();
  });

  test("half of an emoji is repaired in the fields and kept as written in the card", async () => {
    const text = String.raw`{"spec":"chara_card_v2","data":{"name":"Broken \ud83d","nickname":"N\ud83d",
      "creator_notes_multilingual":{"e\ud83dn":"x\ud83d"},
      "character_book":{"entries":[{"keys":["k"],"content":"c","name":"\u00e2\udc9d\u00a4"}]}}}`;
    const { read } = await readCardFile(new File([text], "broken.json"));
    expect(read.character).toMatchObject({
      name: "Broken \uFFFD", nickname: "N\uFFFD", creator_notes_multilingual: { "e\uFFFDn": "x\uFFFD" },
      lore_entries: [{ comment: "\u00e2\uFFFD\u00a4", origin: 0 }],
    });
    expect(read.original.text).toBe(text);
    expect(read.original.text).toContain(String.raw`\ud83d`);
  });

  test("a card of several megabytes reads whole", async () => {
    const card = { spec: "chara_card_v2", data: { name: "Large", extensions: { risuai: { image: "A".repeat(7 * 1024 * 1024) } } } };
    const text = JSON.stringify(card);
    const { read } = await readCardFile(new File([text], "large.json"));
    expect(read.character.name).toBe("Large");
    expect(read.original.text.length).toBe(text.length);
    expect(read.original.text).toBe(text);
  });

  test("the original text is the file's, less its byte order mark", async () => {
    const text = '{ "name": "Vane",\r\n  "first_mes": "Late." }\n';
    const { read } = await readCardFile(new File(["\uFEFF" + text], "vane.json"));
    expect(read.original).toEqual({ text, format: "json", other_text: null });
  });

  test("the tagline offered is the first sentence of the presentation, without its layout", () => {
    const tagline = (creator_notes: string) => v2({ creator_notes }).suggestedTagline;
    expect(tagline("<style>p { color: red }</style><p><b>Oyelaran</b> keeps the harbor.</p> More text.")).toBe("Oyelaran keeps the harbor.");
    expect(tagline("<script>alert(1)</script># A *keeper* of _light_\n> Quoted ~~text~~ and `code`! Then more.")).toBe("A keeper of light Quoted text and code!");
    expect(tagline("> > A quote within a quote. More.")).toBe("A quote within a quote.");
    expect(tagline("  ## > Heading and quote. More.")).toBe("Heading and quote.");
    expect(tagline("![portrait](https://example.com/a.png)Read [the guide](https://example.com) first... or not")).toBe("Read the guide first...");
    expect(tagline("Salt &amp; iron, &lt;sharp&gt; &quot;edges&quot; &#39;here&#39;&nbsp;now")).toBe(`Salt & iron, <sharp> "edges" 'here' now`);
    expect(tagline("東京の門番。 二つ目の文")).toBe("東京の門番。");
    // Japanese and Chinese put no space after their marks.
    expect(tagline("東京の門番。二つ目の文。")).toBe("東京の門番。");
    expect(tagline("門を守れ！二つ目の文")).toBe("門を守れ！");
    expect(tagline("誰が来た？二つ目の文")).toBe("誰が来た？");
    // A mark inside a quotation ends the sentence with the quote it closes, and a doubled mark stays whole.
    expect(tagline("「おかえりなさい！」あなたを待つ門番。")).toBe("「おかえりなさい！」");
    expect(tagline("她说：“门不会开。”然后离开了。")).toBe("她说：“门不会开。”");
    expect(tagline("すごい！！本当に？")).toBe("すごい！！");
    // A straight quote goes with the sentence only when it closes one: here it opens the next.
    expect(tagline('她笑了。"你好。"她说。')).toBe("她笑了。");
    expect(tagline("港は静かだ。'ようこそ。'と彼女。")).toBe("港は静かだ。");
    expect(tagline('她说："门不会开。"然后离开了。')).toBe('她说："门不会开。"');
    expect(tagline("'行こう！'そして去った。")).toBe("'行こう！'");
    expect(tagline("(笑！)次の文。")).toBe("(笑！)");
    expect(tagline("[注意！]次の文。")).toBe("[注意！]");
    // Closers and closing quotes go with it in whatever order the quotations nest.
    expect(tagline(`她说："他说'好。'"然后离开了。`)).toBe(`她说："他说'好。'"`);
    expect(tagline('「彼は"行こう！"」と言った。次。')).toBe('「彼は"行こう！"」');
    expect(tagline('（他说"好。"）然后。')).toBe('（他说"好。"）');
    expect(tagline('(他说"好。")然后。')).toBe('(他说"好。")');
    // An apostrophe within a word opens no quotation.
    expect(tagline("Tom's '行こう！'そして去った。")).toBe("Tom's '行こう！'");
    expect(tagline("Tom's 冒険が始まる！'やあ'と彼は言った。")).toBe("Tom's 冒険が始まる！");
    expect(tagline("Version 1.5 is out? Yes")).toBe("Version 1.5 is out?");
    expect(tagline("No end to this one")).toBe("No end to this one");
    expect(tagline("")).toBe("");
  });
});
