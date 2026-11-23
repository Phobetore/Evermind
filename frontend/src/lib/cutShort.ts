import type { Translate } from "@/i18n/I18nProvider";
import type { Message } from "@/types";

/** Whether the version of a reply on screen was cut short: the server says which versions were,
 *  by their index, from the first write of one until its last says it is whole. */
export function isCutShort(message: Pick<Message, "meta" | "active_index">): boolean {
  const marks = message.meta?.interrupted;
  return Array.isArray(marks) && marks.includes(message.active_index);
}

/** Why the version of a reply on screen is cut, when the connection's max tokens cut it rather than
 *  anyone: the server marks such a version by its index, with the max tokens it was written under,
 *  or none when the connection set none. Null for any other version. */
export function describeCeiling(message: Pick<Message, "meta" | "active_index">, t: Translate): string | null {
  const marks = message.meta?.ceiling;
  if (!marks || typeof marks !== "object" || Array.isArray(marks)) return null;
  const key = String(message.active_index);
  if (!Object.hasOwn(marks, key)) return null;
  const tokens = (marks as Record<string, unknown>)[key];
  return typeof tokens === "number" && tokens > 0
    ? t("chat.message.cutAtCeiling", { tokens })
    : t("chat.message.cutAtCeilingUnset");
}
