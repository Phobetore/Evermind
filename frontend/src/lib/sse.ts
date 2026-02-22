/** SSE client for the /chat/stream endpoint. */

export interface ChatStreamToken {
  token: string;
}

export interface ChatStreamDone {
  done: true;
  message_id: string;
  meta: Record<string, unknown>;
}

export interface ChatStreamError {
  error: string;
}

export interface ChatStreamStatus {
  status: string;
  detail: string;
}

export type ChatStreamEvent = ChatStreamToken | ChatStreamDone | ChatStreamError | ChatStreamStatus;

export function isChatDone(event: ChatStreamEvent): event is ChatStreamDone {
  return "done" in event && event.done === true;
}

export function isChatError(event: ChatStreamEvent): event is ChatStreamError {
  return "error" in event;
}

export function isChatToken(event: ChatStreamEvent): event is ChatStreamToken {
  return "token" in event && !("done" in event);
}

export function isChatStatus(event: ChatStreamEvent): event is ChatStreamStatus {
  return "status" in event && !("done" in event) && !("error" in event) && !("token" in event);
}

/**
 * Stream chat tokens from the backend SSE endpoint.
 *
 * Uses fetch + ReadableStream (not EventSource) to support POST requests.
 */
export async function* streamChat(
  conversationId: string,
  characterId: string,
  userMessage: string,
  profileId: string = "balanced",
  generationParams: Record<string, unknown> = {},
): AsyncGenerator<ChatStreamEvent> {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversation_id: conversationId,
      character_id: characterId,
      user_message: userMessage,
      profile_id: profileId,
      generation_params: generationParams,
    }),
  });

  if (!response.ok) {
    yield { error: `HTTP ${response.status}: ${response.statusText}` };
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    yield { error: "No response body" };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const jsonStr = trimmed.slice(6);
      try {
        const event = JSON.parse(jsonStr) as ChatStreamEvent;
        yield event;
      } catch {
        // Skip malformed lines
      }
    }
  }

  // Process any remaining buffer
  if (buffer.trim().startsWith("data: ")) {
    const jsonStr = buffer.trim().slice(6);
    try {
      const event = JSON.parse(jsonStr) as ChatStreamEvent;
      yield event;
    } catch {
      // Skip
    }
  }
}
