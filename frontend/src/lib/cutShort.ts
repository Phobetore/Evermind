import type { Translate } from "@/i18n/I18nProvider";
import type { Message } from "@/types";

/** Whether the version of a reply on screen was cut short: the server says which versions were,
 *  by their index, from the first write of one until its last says it is whole. */
export function isCutShort(message: Pick<Message, "meta" | "active_index">): boolean {
  const marks = message.meta?.interrupted;
  return Array.isArray(marks) && marks.includes(message.active_index);
}

/** Whether the version of a reply on screen was cut by the connection's max tokens rather than by
 *  anyone: the server marks such a version by its index. */
export function isCutAtCeiling(message: Pick<Message, "meta" | "active_index">): boolean {
  const marks = message.meta?.ceiling;
  return Boolean(marks) && typeof marks === "object" && !Array.isArray(marks)
    && Object.hasOwn(marks as object, String(message.active_index));
}

/** Why the version of a reply on screen is cut, when the connection's max tokens cut it rather than
 *  anyone: the server marks such a version by its index, with the max tokens it was written under,
 *  or none when the connection set none. Null for any other version. */
export function describeCeiling(message: Pick<Message, "meta" | "active_index">, t: Translate): string | null {
  if (!isCutAtCeiling(message)) return null;
  const tokens = ceilingTokens(message);
  return tokens !== null ? t("chat.message.cutAtCeiling", { tokens }) : t("chat.message.cutAtCeilingUnset");
}

/** The max tokens the version on screen was cut at, when the server knows it: only a figure of the
 *  person's own can be lifted. */
export function ceilingTokens(message: Pick<Message, "meta" | "active_index">): number | null {
  if (!isCutAtCeiling(message)) return null;
  const tokens = (message.meta!.ceiling as Record<string, unknown>)[String(message.active_index)];
  return typeof tokens === "number" && tokens > 0 ? tokens : null;
}
