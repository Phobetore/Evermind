"use client";

import ChatInput from "@/components/chat/ChatInput";
import ChatHeader from "@/components/chat/ChatHeader";
import ChatMessage from "@/components/chat/ChatMessage";
import StreamingBubble from "@/components/chat/StreamingBubble";
import { ChatMessageSkeleton } from "@/components/ui/Skeleton";
import { useStreaming } from "@/contexts/StreamingContext";
import { api } from "@/lib/api";
import { getSelectedProfile } from "@/lib/generation-params";
import type { Character, Conversation, Message, UserPersona } from "@/types";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

export default function ChatConversationPage() {
  const params = useParams();
  const conversationId = params?.conversationId as string;
  const { startStream, isStreaming, getStreamContent, getStatusDetail, getStatus } = useStreaming();

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [character, setCharacter] = useState<Character | null>(null);
  const [persona, setPersona] = useState<UserPersona | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeProfile, setActiveProfile] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const streaming = isStreaming(conversationId);
  const streamingContent = getStreamContent(conversationId);
  const statusDetail = getStatusDetail(conversationId);
  const streamStatus = getStatus(conversationId);

  const onMessageRef = useRef<(msg: Message) => void>(() => {});
  onMessageRef.current = (msg: Message) => {
    setMessages((prev) => [...prev, msg]);
  };

  useEffect(() => {
    setActiveProfile(getSelectedProfile());
    if (!conversationId) return;
    (async () => {
      try {
        const conv = await api.get<Conversation>(`/conversations/${conversationId}`);
        setConversation(conv);

        const fetches: Promise<unknown>[] = [
          api.get<Character>(`/characters/${conv.character_id}`),
          api.get<Message[]>(`/conversations/${conversationId}/messages?limit=100`),
        ];
        if (conv.user_persona_id) {
          fetches.push(api.get<UserPersona>(`/user_personas/${conv.user_persona_id}`).catch(() => null));
        }

        const [char, msgs, pers] = await Promise.all(fetches);
        setCharacter(char as Character);
        setMessages(msgs as Message[]);
        if (pers) setPersona(pers as UserPersona);
      } finally {
        setLoading(false);
      }
    })();
  }, [conversationId]);

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingContent, scrollToBottom]);

  function doStream(userMessage: string, regenerate: boolean = false) {
    if (!conversation || !character) return;
    setActiveProfile(getSelectedProfile());
    startStream(conversationId, character.id, userMessage, (msg) => onMessageRef.current(msg), regenerate);
  }

  function handleSend(content: string) {
    if (!conversation || !character || streaming) return;
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
    let lastUserMsg: Message | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUserMsg = messages[i];
        break;
      }
    }
    if (!lastUserMsg) return;

    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant") return prev.slice(0, -1);
      return prev;
    });

    doStream(lastUserMsg.content, true);
  }

  function handleEditMessage(messageId: string, newContent: string) {
    if (!conversation || !character || streaming) return;
    const editIdx = messages.findIndex((m) => m.id === messageId);
    if (editIdx === -1) return;

    const editedMsg: Message = { ...messages[editIdx], content: newContent };
    setMessages((prev) => [...prev.slice(0, editIdx), editedMsg]);
    doStream(newContent);
  }

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="shrink-0 border-b border-border px-6 py-3 flex items-center gap-3">
          <div className="animate-pulse h-8 w-8 rounded-full bg-surface-light" />
          <div className="space-y-1">
            <div className="animate-pulse h-4 w-24 rounded bg-surface-light" />
            <div className="animate-pulse h-3 w-16 rounded bg-surface-light" />
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

  if (!conversation || !character) return <div className="p-6 text-zinc-500">Conversation not found</div>;

  const lastMsg = messages[messages.length - 1];
  const lastIsAssistant = lastMsg?.role === "assistant";
  const memoryTips = [
    "Active profile impacts best-of-N and self-refine.",
    "Use regenerate on the last assistant message to improve coherence.",
    "Edit your previous message to force a branch without losing context.",
  ];

  return (
    <div className="h-full p-4 md:p-5 bg-[radial-gradient(circle_at_20%_0%,rgba(124,58,237,0.2),transparent_40%)]">
      <div className="h-full grid grid-cols-1 xl:grid-cols-[1fr_300px] gap-4">
        <div className="flex flex-col h-full rounded-2xl border border-border bg-surface/85 backdrop-blur">
          <ChatHeader character={character} conversation={conversation} activeProfile={activeProfile} persona={persona} />

          <div ref={scrollRef} className="flex-1 overflow-auto p-6 space-y-4">
            {messages.length === 0 && !streaming && (
              <div className="text-center py-12 text-zinc-500 text-sm">Start the conversation by sending a message.</div>
            )}

            {messages.map((msg, idx) => (
              <ChatMessage
                key={msg.id}
                message={msg}
                characterName={character.name}
                isLast={idx === messages.length - 1 && lastIsAssistant && !streaming}
                onRegenerate={handleRegenerate}
                onEditMessage={handleEditMessage}
                userPersona={persona}
              />
            ))}

            {streaming && (
              <StreamingBubble
                characterName={character.name}
                content={streamingContent}
                status={streamStatus}
                statusDetail={statusDetail}
              />
            )}
          </div>

          <div className="shrink-0 border-t border-border p-4">
            <ChatInput onSend={handleSend} disabled={streaming} />
          </div>
        </div>

        <aside className="hidden xl:flex flex-col gap-4 rounded-2xl border border-border bg-surface/70 p-4">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Scene Anchor</h3>
            <p className="text-xs text-zinc-400 mt-2 leading-relaxed">{character.summary || "Add a stronger summary in character settings for better immersion and narrative consistency."}</p>
          </div>
          <div className="rounded-xl border border-border bg-surface-light/50 p-3">
            <p className="text-xs uppercase tracking-wider text-zinc-500">Scenario</p>
            <p className="text-sm text-zinc-200 mt-1 whitespace-pre-wrap">{character.scenario || "No scenario set"}</p>
          </div>
          <div className="rounded-xl border border-border bg-surface-light/50 p-3">
            <p className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Session Tips</p>
            <ul className="space-y-2 text-xs text-zinc-300">
              {memoryTips.map((tip) => (
                <li key={tip}>• {tip}</li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
