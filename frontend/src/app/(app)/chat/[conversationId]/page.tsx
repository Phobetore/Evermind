"use client";

import ChatInput from "@/components/chat/ChatInput";
import ChatMessage from "@/components/chat/ChatMessage";
import { api } from "@/lib/api";
import {
  isChatDone,
  isChatError,
  isChatToken,
  streamChat,
} from "@/lib/sse";
import type { Character, Conversation, Message } from "@/types";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

export default function ChatConversationPage() {
  const params = useParams();
  const conversationId = params?.conversationId as string;

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [character, setCharacter] = useState<Character | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load conversation, character, and messages
  useEffect(() => {
    if (!conversationId) return;
    (async () => {
      try {
        const conv = await api.get<Conversation>(
          `/conversations/${conversationId}`
        );
        setConversation(conv);

        const [char, msgs] = await Promise.all([
          api.get<Character>(`/characters/${conv.character_id}`),
          api.get<Message[]>(
            `/conversations/${conversationId}/messages?limit=100`
          ),
        ]);
        setCharacter(char);
        setMessages(msgs);
      } catch {
        // conversation may not exist
      } finally {
        setLoading(false);
      }
    })();
  }, [conversationId]);

  // Auto-scroll
  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingContent, scrollToBottom]);

  async function handleSend(content: string) {
    if (!conversation || !character || streaming) return;

    // Optimistically add user message
    const userMsg: Message = {
      id: `temp-${Date.now()}`,
      conversation_id: conversationId,
      role: "user",
      content,
      created_at: new Date().toISOString(),
      meta: {},
    };
    setMessages((prev) => [...prev, userMsg]);
    setStreaming(true);
    setStreamingContent("");

    try {
      let fullContent = "";

      for await (const event of streamChat(
        conversationId,
        character.id,
        content
      )) {
        if (isChatToken(event)) {
          fullContent += event.token;
          setStreamingContent(fullContent);
        } else if (isChatDone(event)) {
          // Replace streaming content with the final message
          const assistantMsg: Message = {
            id: event.message_id,
            conversation_id: conversationId,
            role: "assistant",
            content: fullContent,
            created_at: new Date().toISOString(),
            meta: event.meta,
          };
          setMessages((prev) => [...prev, assistantMsg]);
          setStreamingContent("");
        } else if (isChatError(event)) {
          // Show error as a system message
          const errorMsg: Message = {
            id: `error-${Date.now()}`,
            conversation_id: conversationId,
            role: "system",
            content: `Error: ${event.error}`,
            created_at: new Date().toISOString(),
            meta: {},
          };
          setMessages((prev) => [...prev, errorMsg]);
          setStreamingContent("");
        }
      }
    } catch {
      // Network error
      setStreamingContent("");
    } finally {
      setStreaming(false);
    }
  }

  if (loading) return <div className="p-6 text-zinc-500">Loading…</div>;
  if (!conversation || !character)
    return <div className="p-6 text-zinc-500">Conversation not found</div>;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 border-b border-zinc-800 px-6 py-3 flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-800 text-sm">
          {character.name.charAt(0).toUpperCase()}
        </div>
        <div>
          <div className="font-medium text-sm">{character.name}</div>
          <div className="text-xs text-zinc-500">
            {conversation.title || "Conversation"}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-auto p-6 space-y-4">
        {messages.map((msg) => (
          <ChatMessage
            key={msg.id}
            message={msg}
            characterName={character.name}
          />
        ))}

        {/* Streaming indicator */}
        {streaming && streamingContent && (
          <div className="flex gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-700 text-sm">
              {character.name.charAt(0).toUpperCase()}
            </div>
            <div className="max-w-[75%] rounded-2xl bg-zinc-800 px-4 py-2.5 text-sm leading-relaxed text-zinc-100">
              {streamingContent}
              <span className="inline-block w-2 h-4 ml-0.5 bg-zinc-400 animate-pulse" />
            </div>
          </div>
        )}

        {streaming && !streamingContent && (
          <div className="flex gap-3 items-center">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-700 text-sm">
              {character.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex gap-1">
              {[0, 150, 300].map((delay) => (
                <span
                  key={delay}
                  className="w-2 h-2 rounded-full bg-zinc-500 animate-bounce"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-zinc-800 p-4">
        <ChatInput onSend={handleSend} disabled={streaming} />
      </div>
    </div>
  );
}
