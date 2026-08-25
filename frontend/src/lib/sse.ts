import type { ChatEvent } from "@/types";

interface ChatBody {
  conversation_id: string;
  mode: "send" | "regenerate" | "continue";
  content?: string;
  message_mode?: "say" | "narrate" | "ooc";
}

/** POST /api/chat and dispatch each SSE event. Resolves when the stream ends. */
export async function streamChat(
  body: ChatBody,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return readEvents(
    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
    onEvent,
  );
}

/** Attach to a reply already being written somewhere else — a phone coming
 *  back to a conversation it left mid-turn. The server hands over what has
 *  arrived so far and then the rest; an empty stream means nothing is running,
 *  which is not an error. */
export async function followTurn(
  conversationId: string,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return readEvents(
    fetch(`/api/conversations/${conversationId}/turn/stream`, { signal }),
    onEvent,
  );
}

async function readEvents(
  pending: Promise<Response>,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const resp = await pending;
  if (!resp.ok || !resp.body) {
    throw new Error(`Erreur ${resp.status}. Le serveur Evermind est-il lancé ?`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flush = (raw: string) => {
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as ChatEvent);
      } catch {
        /* partial JSON never happens on \n\n boundaries; ignore garbage */
      }
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
