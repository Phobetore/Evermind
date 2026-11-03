import type { Message } from "@/types";

/** Whether the version of a reply on screen was cut short. The server says which versions
 *  were, by their index; a reply stored by an older version says only that it was, of the
 *  whole message, which reads as the version active. */
export function isCutShort(message: Pick<Message, "meta" | "active_index">): boolean {
  const marks = message.meta?.interrupted;
  return marks === true || (Array.isArray(marks) && marks.includes(message.active_index));
}
