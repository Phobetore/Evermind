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
  const resp = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
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
