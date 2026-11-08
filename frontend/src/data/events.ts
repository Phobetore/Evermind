import type { TurnEvent } from "@/types";
import { networkFailure } from "./request";

/** Dispatch each server-sent event of a streaming answer. Resolves when the
 *  stream ends. `pending` is a response that `send` has already checked: a
 *  failed one has raised by now. */
export async function readEvents(
  pending: Promise<Response>,
  onEvent: (event: TurnEvent) => void,
): Promise<void> {
  const resp = await pending;
  // A response with no body object, a 204 for one, has nothing to read.
  if (!resp.body) return;

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flush = (raw: string) => {
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      let event: TurnEvent;
      try {
        event = JSON.parse(line.slice(5).trim()) as TurnEvent;
      } catch {
        /* partial JSON never happens on \n\n boundaries; ignore garbage */
        continue;
      }
      // Outside the try on purpose: only the parsing is forgiven. A handler
      // that throws has a bug, and swallowing it here would hide it.
      onEvent(event);
    }
  };

  try {
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
  } finally {
    // A handler that threw leaves the rest of the answer unread. Letting go of
    // it tells the server nobody is listening, instead of leaving the
    // connection open until it ends. Once the stream is finished there is
    // nothing left to cancel, and one that failed refuses to be cancelled,
    // which is no news.
    reader.cancel().catch(() => {});
  }
}
