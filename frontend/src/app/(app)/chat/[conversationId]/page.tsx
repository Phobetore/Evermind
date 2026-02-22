"use client";

import ChatInput from "@/components/chat/ChatInput";
import ChatMessage from "@/components/chat/ChatMessage";
import { ChatMessageSkeleton } from "@/components/ui/Skeleton";
import { api } from "@/lib/api";
import { useStreaming } from "@/contexts/StreamingContext";
import type { Character, Conversation, Message } from "@/types";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

export default function ChatConversationPage() {
  const params = useParams();
  const conversationId = params?.conversationId as string;
  const { startStream, isStreaming, getStreamContent } = useStreaming();

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [character, setCharacter] = useState<Character | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const streaming = isStreaming(conversationId);
  const streamingContent = getStreamContent(conversationId);

  // Stable callback ref for message handling
  // Ref-based callback avoids re-creating startStream closure when messages change
  const onMessageRef = useRef<(msg: Message) => void>(() => {});
  onMessageRef.current = (msg: Message) => {
    setMessages((prev) => [...prev, msg]);
  };

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

  function doStream(userMessage: string) {
    if (!conversation || !character) return;
    startStream(
      conversationId,
      character.id,
      userMessage,
      (msg) => onMessageRef.current(msg),
    );
  }

  function handleSend(content: string) {
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

    doStream(content);
  }

  function handleRegenerate() {
    if (!conversation || !character || streaming) return;

    // Find the last user message to re-send
    let lastUserMsg: Message | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUserMsg = messages[i];
        break;
      }
    }
    if (!lastUserMsg) return;

    // Remove the last assistant message
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant") {
        return prev.slice(0, -1);
      }
      return prev;
    });

    doStream(lastUserMsg.content);
  }

  function handleEditMessage(messageId: string, newContent: string) {
    if (!conversation || !character || streaming) return;

    // Find the edited message index
    const editIdx = messages.findIndex((m) => m.id === messageId);
    if (editIdx === -1) return;

    // Replace the edited message and remove all messages after it
    const editedMsg: Message = {
      ...messages[editIdx],
      content: newContent,
    };
    setMessages((prev) => [...prev.slice(0, editIdx), editedMsg]);

    // Re-generate assistant response with the edited content
    doStream(newContent);
  }

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="shrink-0 border-b border-[#2a2440] px-6 py-3 flex items-center gap-3">
          <div className="animate-pulse h-8 w-8 rounded-full bg-[#1e1a2e]" />
          <div className="space-y-1">
            <div className="animate-pulse h-4 w-24 rounded bg-[#1e1a2e]" />
            <div className="animate-pulse h-3 w-16 rounded bg-[#1e1a2e]" />
          </div>
        </div>
        <div className="flex-1 overflow-auto p-6 space-y-4">
          <ChatMessageSkeleton />
          <ChatMessageSkeleton isUser />
          <ChatMessageSkeleton />
        </div>
      </div>
    );
  }

  if (!conversation || !character)
    return <div className="p-6 text-zinc-500">Conversation not found</div>;

  // Determine if last message is assistant (for regenerate button)
  const lastMsg = messages[messages.length - 1];
  const lastIsAssistant = lastMsg?.role === "assistant";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 border-b border-[#2a2440] px-6 py-3 flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-violet-600 to-purple-800 text-sm font-medium">
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
        {messages.length === 0 && !streaming && (
          <div className="text-center py-12 text-zinc-500 text-sm">
            Start the conversation by sending a message.
          </div>
        )}

        {messages.map((msg, idx) => (
          <ChatMessage
            key={msg.id}
            message={msg}
            characterName={character.name}
            isLast={idx === messages.length - 1 && lastIsAssistant && !streaming}
            onRegenerate={handleRegenerate}
            onEditMessage={handleEditMessage}
          />
        ))}

        {/* Streaming indicator */}
        {streaming && streamingContent && (
          <div className="flex gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-600 to-purple-800 text-sm font-medium">
              {character.name.charAt(0).toUpperCase()}
            </div>
            <div className="max-w-[75%] rounded-2xl bg-[#1e1a2e] px-4 py-2.5 text-sm leading-relaxed text-zinc-100">
              {streamingContent}
              <span className="inline-block w-2 h-4 ml-0.5 bg-violet-400 animate-pulse" />
            </div>
          </div>
        )}

        {streaming && !streamingContent && (
          <div className="flex gap-3 items-center">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-600 to-purple-800 text-sm font-medium">
              {character.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex gap-1">
              {[0, 150, 300].map((delay) => (
                <span
                  key={delay}
                  className="w-2 h-2 rounded-full bg-violet-400 animate-bounce"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-[#2a2440] p-4">
        <ChatInput onSend={handleSend} disabled={streaming} />
      </div>
    </div>
  );
}
