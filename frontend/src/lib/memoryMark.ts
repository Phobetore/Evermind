import type { Conversation } from "@/types";

/** Whether the conversation's header marks its memory as stuck: while its pass (the automatic one
 *  or a Remember) or a Condense has failed, until that work succeeds. On a phone the panel that
 *  says why is rarely open, and the memory would stop growing with nobody knowing. Only the
 *  conversation's own field is read, which every edition's conversation carries. */
export function memoryFailed(conversation: Pick<Conversation, "memory_error">): boolean {
  return Boolean(conversation.memory_error);
}
