import type { Message } from "@/types";

/** Whether the version of a reply on screen was cut short: the server says which versions were,
 *  by their index, from the first write of one until its last says it is whole. */
export function isCutShort(message: Pick<Message, "meta" | "active_index">): boolean {
  const marks = message.meta?.interrupted;
  return Array.isArray(marks) && marks.includes(message.active_index);
}
