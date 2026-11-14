// The places in a card that held something Evermind could not read, said as the form names them.

import { fieldLabelKey } from "@/components/editor/fieldLabels";
import type { CardCharacter } from "@/data";
import { FIELDS } from "@/lib/cards/read";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** The field each place of the card is read into, where the form has one of its own. */
const PLACES: Record<string, string> = {
  ...FIELDS,
  nickname: "nickname",
  // SillyTavern keeps the notes of a V1 card there.
  creatorcomment: "creator_notes",
  alternate_greetings: "alternate_greetings",
  tags: "tags",
  creator_notes_multilingual: "creator_notes_multilingual",
  "extensions.depth_prompt": "character_note",
  "extensions.depth_prompt.prompt": "character_note",
  "extensions.evermind.tagline": "tagline",
  character_book: "lore_entries",
  "character_book.entries": "lore_entries",
};

/** What a person reads for the places of `unreadFields`: the form's names for its fields, and an
 *  entry of the lorebook by its title, else its first key, else its number; each said once. */
export function unreadLabels(paths: string[], character: CardCharacter, t: Translate): string[] {
  const said = paths.map((path) => {
    const field = PLACES[path];
    if (field) return t(fieldLabelKey(field, character.kind));
    const language = /^creator_notes_multilingual\.(.+)$/.exec(path);
    if (language) return `${t(fieldLabelKey("creator_notes_multilingual", character.kind))} (${language[1]})`;
    const entry = /^character_book\.entries\.(\d+)\./.exec(path);
    if (entry) {
      const index = Number(entry[1]);
      const read = character.lore_entries.find((item) => item.origin === index);
      const name = read?.comment.trim() || read?.keys[0] || t("lorebook.entryNumber", { number: index + 1 });
      return `${t("lorebook.title")}: ${name}`;
    }
    return path;
  });
  return [...new Set(said)];
}
