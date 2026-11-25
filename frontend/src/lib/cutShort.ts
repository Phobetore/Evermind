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

/** The AI (its row id) that wrote the version on screen when the connection's max tokens cut it,
 *  as the server stored it beside the mark; null for a version cut before it stored one. */
export function cutAiId(message: Pick<Message, "meta" | "active_index">): string | null {
  const causes = message.meta?.cut;
  if (!causes || typeof causes !== "object" || Array.isArray(causes)) return null;
  const cause = (causes as Record<string, unknown>)[String(message.active_index)];
  const id = cause && typeof cause === "object" ? (cause as Record<string, unknown>).model_id : null;
  return typeof id === "string" ? id : null;
}

/** Whether the ceiling `ai` keeps is the one that cut the version on screen, and so lifting it would
 *  have saved it: the AI that wrote it (where the server said which), a ceiling of its own still,
 *  at the figure the reply was cut at. */
export function cutAtCeilingOf(
  message: Pick<Message, "meta" | "active_index">,
  ai: { id: string; reply_cap: { mode: string; tokens: number | null } },
): boolean {
  const by = cutAiId(message);
  return (by === null || by === ai.id) && ai.reply_cap.mode === "fixed"
    && ceilingTokens(message) !== null && ceilingTokens(message) === ai.reply_cap.tokens;
}

/** What can be done about a cut reply from the line under it. */
export type CutAction = "extend" | "letEvermind" | "longHere" | "retry";

const LENGTHS = ["short", "medium", "long"];

/** Why the version on screen was cut, as the server stored it beside the mark, or null for one it
 *  cannot read: the AI's ceiling at the time, the way's length, and whether its thinking took the
 *  room from a reply that barely began. */
function causeOf(message: Pick<Message, "meta" | "active_index">) {
  const causes = message.meta?.cut;
  if (!causes || typeof causes !== "object" || Array.isArray(causes)) return null;
  const cause = (causes as Record<string, unknown>)[String(message.active_index)];
  if (!cause || typeof cause !== "object") return null;
  const { mode, length, thought } = cause as Record<string, unknown>;
  if (mode !== "fixed" && mode !== "auto" && mode !== "unsent") return null;
  if (typeof length !== "string" || !LENGTHS.includes(length)) return null;
  return { mode, length, thought: thought === true };
}

/** The line under a cut reply and the buttons that help, by what cut it. A reply cut before the
 *  cause was stored says what it said then; only a figure of the AI's own can be lifted. No amount
 *  is ever said here. "letEvermind" is shown only where the page can lift the AI's ceiling. */
export function describeCut(
  message: Pick<Message, "meta" | "active_index">,
  t: Translate,
): { text: string; actions: CutAction[] } | null {
  if (!isCutAtCeiling(message)) return null;
  const ceiling = describeCeiling(message, t)!;
  const cause = causeOf(message);
  if (!cause) return { text: ceiling, actions: ceilingTokens(message) !== null ? ["letEvermind"] : [] };
  if (cause.mode === "fixed") return { text: ceiling, actions: ["extend", "letEvermind"] };
  if (cause.thought) return { text: t("chat.message.cutThought"), actions: ["extend", "retry"] };
  if (cause.mode === "auto") {
    return {
      text: t(`chat.message.cutRoom.${cause.length}`),
      actions: cause.length === "long" ? ["extend"] : ["extend", "longHere"],
    };
  }
  return { text: t("chat.message.cutAtCeilingUnset"), actions: ["extend"] };
}
