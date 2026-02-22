"use client";

import type { Message } from "@/types";
import { getGenerationParams } from "@/lib/generation-params";
import {
  isChatDone,
  isChatError,
  isChatToken,
  streamChat,
} from "@/lib/sse";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface StreamState {
  streaming: boolean;
  content: string;
}

interface StreamingContextValue {
  /** Map of conversationId → current stream state. */
  streams: Record<string, StreamState>;
  /** Start streaming a response for a conversation. Returns the completed assistant message or null on error. */
  startStream: (
    conversationId: string,
    characterId: string,
    userMessage: string,
    onMessage: (msg: Message) => void,
  ) => void;
  /** Whether a specific conversation is currently streaming. */
  isStreaming: (conversationId: string) => boolean;
  /** Get the current streaming content for a conversation. */
  getStreamContent: (conversationId: string) => string;
}

const StreamingContext = createContext<StreamingContextValue | null>(null);

export function StreamingProvider({ children }: { children: ReactNode }) {
  const [streams, setStreams] = useState<Record<string, StreamState>>({});
  const abortControllers = useRef<Record<string, AbortController>>({});

  const startStream = useCallback(
    (
      conversationId: string,
      characterId: string,
      userMessage: string,
      onMessage: (msg: Message) => void,
    ) => {
      // Abort any existing stream for this conversation
      abortControllers.current[conversationId]?.abort();
      const controller = new AbortController();
      abortControllers.current[conversationId] = controller;

      setStreams((prev) => ({
        ...prev,
        [conversationId]: { streaming: true, content: "" },
      }));

      (async () => {
        try {
          let fullContent = "";
          const genParams = getGenerationParams();

          for await (const event of streamChat(
            conversationId,
            characterId,
            userMessage,
            "balanced",
            { ...genParams },
          )) {
            if (controller.signal.aborted) break;

            if (isChatToken(event)) {
              fullContent += event.token;
              setStreams((prev) => ({
                ...prev,
                [conversationId]: { streaming: true, content: fullContent },
              }));
            } else if (isChatDone(event)) {
              const assistantMsg: Message = {
                id: event.message_id,
                conversation_id: conversationId,
                role: "assistant",
                content: fullContent,
                created_at: new Date().toISOString(),
                meta: event.meta,
              };
              onMessage(assistantMsg);
              setStreams((prev) => ({
                ...prev,
                [conversationId]: { streaming: false, content: "" },
              }));
            } else if (isChatError(event)) {
              const errorMsg: Message = {
                id: `error-${Date.now()}`,
                conversation_id: conversationId,
                role: "system",
                content: `Error: ${event.error}`,
                created_at: new Date().toISOString(),
                meta: {},
              };
              onMessage(errorMsg);
              setStreams((prev) => ({
                ...prev,
                [conversationId]: { streaming: false, content: "" },
              }));
            }
          }
        } catch {
          // Stream was likely aborted or failed
        } finally {
          setStreams((prev) => {
            const current = prev[conversationId];
            if (current?.streaming) {
              return {
                ...prev,
                [conversationId]: { streaming: false, content: "" },
              };
            }
            return prev;
          });
          delete abortControllers.current[conversationId];
        }
      })();
    },
    [],
  );

  const isStreaming = useCallback(
    (conversationId: string) => streams[conversationId]?.streaming ?? false,
    [streams],
  );

  const getStreamContent = useCallback(
    (conversationId: string) => streams[conversationId]?.content ?? "",
    [streams],
  );

  return (
    <StreamingContext.Provider
      value={{ streams, startStream, isStreaming, getStreamContent }}
    >
      {children}
    </StreamingContext.Provider>
  );
}

export function useStreaming() {
  const ctx = useContext(StreamingContext);
  if (!ctx) throw new Error("useStreaming must be used within StreamingProvider");
  return ctx;
}
