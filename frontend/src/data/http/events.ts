import type { ChatEvent } from "@/types";
import { raiseFor } from "./request";

/** Dispatch each server-sent event of a streaming answer. Resolves when the
 *  stream ends. */
export async function readEvents(
  pending: Promise<Response>,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const resp = await pending;
  if (!resp.ok) await raiseFor(resp);
  // No body at all is the server having nothing to say, which is how an idle
  // conversation answers a request to follow its turn.
  if (!resp.body) return;

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flush = (raw: string) => {
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      let event: ChatEvent;
      try {
        event = JSON.parse(line.slice(5).trim()) as ChatEvent;
      } catch {
        /* partial JSON never happens on \n\n boundaries; ignore garbage */
        continue;
      }
      // Outside the try on purpose: only the parsing is forgiven. A handler
      // that throws has a bug, and swallowing it here would hide it.
      onEvent(event);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    blocks.forEach(flush);
  }
  if (buffer.trim()) flush(buffer);
}
