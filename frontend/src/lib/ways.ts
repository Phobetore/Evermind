// How the interface names a way of playing and says what it rereads.

import type { Translate as T } from "@/i18n/I18nProvider";
import { BUILT_IN } from "@/engine";
import type { Outlook, OutlookEntry, Way, WayFields, Ways } from "@/types";
import { pages } from "./estimate";

/** The way offered to new conversations, whose figures every estimate where an AI is chosen
 *  weighs; balanced if the list somehow lacks it, as the server plays an unknown way. */
export function offeredWay(ways: Ways): WayFields {
  return ways.ways.find((way) => way.id === ways.default) ?? (BUILT_IN.balanced as WayFields);
}

/** The ways whose name is the interface's: the four built in, and the settings brought over from
 *  before ways existed. */
const NAMED = new Set(["light", "balanced", "immersive", "maximum", "mine"]);

/** A way's name in the interface's language; a way a person named keeps that name. */
export function wayName(way: Pick<Way, "id" | "name">, t: T): string {
  if (way.name !== null) return way.name;
  return NAMED.has(way.id) ? t(`ways.names.${way.id}`) : way.id;
}

/** A way's name from its id alone, before the server has said more of it: null for a way a person
 *  made, whose name only the server holds. */
export function nameOfId(id: string, t: T): string | null {
  return NAMED.has(id) ? t(`ways.names.${id}`) : null;
}

/** The messages the way asks to reread of this story: all of it when it rereads all. */
export function asked(entry: OutlookEntry): number {
  return entry.history_limit ? Math.min(entry.history_limit, entry.messages_total) : entry.messages_total;
}

/** The AI's reading capacity is full before the way's messages are all read. */
export function isFull(entry: OutlookEntry): boolean {
  return entry.messages_included < asked(entry);
}

/** The chip of a conversation's way: its name, adjusted when it is, and how much it rereads when
 *  its reading capacity is full. */
export function wayLabel(entry: Outlook["current"], t: T): { text: string; aria: string; full: boolean } {
  const name = wayName(entry.way, t);
  const label = entry.way.adjusted ? t("ways.chip.adjusted", { name }) : name;
  const full = isFull(entry);
  if (!full) return { text: label, aria: t("ways.chip.aria", { label }), full };
  const counts = { label, read: entry.messages_included, asked: asked(entry) };
  return { text: t("ways.chip.full", counts), aria: t("ways.chip.fullAria", counts), full };
}

/** French writes "qu'" before a name that begins with a vowel; the other languages hold the same
 *  sentence under both keys. */
const ELIDED = /^[aeiouyàâäéèêëîïôöùûü]/i;

/** The first line of what the AI reads: the pages sent and the messages reread. `name` null: no AI,
 *  or no capacity said, and then the messages alone. */
export function readingLine(entry: OutlookEntry, name: string | null, t: T): string {
  const full = isFull(entry);
  const counts = { read: entry.messages_included, asked: asked(entry) };
  if (name === null) return t(full ? "ways.reading.lineNoSizeFull" : "ways.reading.lineNoSize", counts);
  const key = `ways.reading.${full ? "lineFull" : "line"}${ELIDED.test(name) ? "Vowel" : ""}`;
  return t(key, { ...counts, name, pages: pages(entry.used_tokens) });
}

/** What Light would reread with the conversation's AI, when that is more than it rereads now. */
export function lighterSaying(outlook: Outlook, t: T): string | null {
  const light = outlook.ways.find((entry) => entry.way.id === "light");
  if (!light || light.messages_included <= outlook.current.messages_included) return null;
  return t("ways.card.lighter", { name: wayName(light.way, t), count: light.messages_included });
}
