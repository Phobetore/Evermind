"use client";

import { api } from "@/lib/api";
import type { Character, Conversation } from "@/types";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

interface ConversationEntry extends Conversation {
  characterName: string;
}

export default function ConversationList() {
  const params = useParams();
  const activeId = params?.conversationId as string | undefined;
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [characters, conversations] = await Promise.all([
          api.get<Character[]>("/characters"),
          api.get<Conversation[]>("/conversations"),
        ]);
        const charMap = new Map(characters.map((c) => [c.id, c.name]));
        const enriched = conversations.map((conv) => ({
          ...conv,
          characterName: charMap.get(conv.character_id) ?? "Unknown",
        }));
        setEntries(enriched);
      } catch {
        setEntries([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <div className="p-3 space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="animate-pulse h-12 rounded-lg bg-zinc-800" />
        ))}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="p-3 text-xs text-zinc-500 text-center">
        No conversations yet
      </div>
    );
  }

  return (
    <nav className="p-2 space-y-1 overflow-auto" aria-label="Conversation history">
      <div className="px-2 py-1 text-xs font-medium text-zinc-500 uppercase tracking-wider">
        History
      </div>
      {entries.map((entry) => {
        const isActive = entry.id === activeId;
        return (
          <Link
            key={entry.id}
            href={`/chat/${entry.id}`}
            className={`flex flex-col gap-0.5 px-3 py-2 rounded-lg text-sm transition-colors ${
              isActive
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
            }`}
          >
            <span className="truncate font-medium text-xs">
              {entry.title || "Untitled"}
            </span>
            <span className="text-[10px] text-zinc-500 truncate">
              {entry.characterName}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
