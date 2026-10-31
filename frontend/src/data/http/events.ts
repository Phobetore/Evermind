import type { ChatEvent } from "@/types";
import { networkFailure } from "./request";

/** Dispatch each server-sent event of a streaming answer. Resolves when the
 *  stream ends. `pending` is a response that `send` has already checked: a
 *  failed one has raised by now. */
export async function readEvents(
  pending: Promise<Response>,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const resp = await pending;
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
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      // The connection dropped in the middle of the answer.
      throw networkFailure(error);
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    blocks.forEach(flush);
  }
  if (buffer.trim()) flush(buffer);
}
