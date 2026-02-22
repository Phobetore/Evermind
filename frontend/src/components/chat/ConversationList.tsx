"use client";

import { api } from "@/lib/api";
import { useStreaming } from "@/contexts/StreamingContext";
import type { Character, Conversation } from "@/types";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Loader2, MoreHorizontal, Pencil, Trash2 } from "lucide-react";

interface ConversationEntry extends Conversation {
  characterName: string;
}

export default function ConversationList() {
  const params = useParams();
  const router = useRouter();
  const activeId = params?.conversationId as string | undefined;
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const { streams } = useStreaming();

  // Context menu state
  const [menuId, setMenuId] = useState<string | null>(null);
  const [menuAbove, setMenuAbove] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Rename state
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

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

  // Close menu on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuId(null);
      }
    }
    if (menuId) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuId]);

  // Reposition menu above if it would overflow the viewport
  useEffect(() => {
    if (menuId && menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      setMenuAbove(rect.bottom > window.innerHeight);
    } else {
      setMenuAbove(false);
    }
  }, [menuId]);

  // Focus rename input
  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  async function handleRename(id: string) {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenamingId(null);
      return;
    }
    try {
      await api.patch<Conversation>(`/conversations/${id}`, { title: trimmed });
      setEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, title: trimmed } : e))
      );
    } catch {
      // ignore
    }
    setRenamingId(null);
  }

  async function handleDelete(id: string) {
    try {
      await api.delete(`/conversations/${id}`);
      setEntries((prev) => prev.filter((e) => e.id !== id));
      if (activeId === id) {
        router.push("/chat");
      }
    } catch {
      // ignore
    }
    setMenuId(null);
  }

  if (loading) {
    return (
      <div className="p-3 space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="animate-pulse h-12 rounded-lg bg-[#1e1a2e]" />
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
        const isCurrentlyStreaming = streams[entry.id]?.streaming;

        return (
          <div key={entry.id} className="relative group/item">
            {renamingId === entry.id ? (
              <div className="px-2 py-1.5">
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => handleRename(entry.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRename(entry.id);
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  className="w-full bg-[#1e1a2e] text-zinc-100 rounded px-2 py-1 text-xs outline-none ring-1 ring-violet-500/50"
                />
              </div>
            ) : (
              <Link
                href={`/chat/${entry.id}`}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? "bg-violet-600/15 text-violet-200 border border-violet-500/20"
                    : "text-zinc-400 hover:bg-[#1e1a2e] hover:text-zinc-200"
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium text-xs">
                      {entry.title || "Untitled"}
                    </span>
                    {isCurrentlyStreaming && (
                      <Loader2 size={12} className="shrink-0 animate-spin text-violet-400" />
                    )}
                  </div>
                  <span className="text-[10px] text-zinc-500 truncate block">
                    {entry.characterName}
                  </span>
                </div>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenuId(menuId === entry.id ? null : entry.id);
                  }}
                  className="opacity-0 group-hover/item:opacity-100 shrink-0 p-1 rounded hover:bg-[#2a2440] text-zinc-500 hover:text-zinc-300 transition-all"
                >
                  <MoreHorizontal size={14} />
                </button>
              </Link>
            )}

            {/* Context menu */}
            {menuId === entry.id && (
              <div
                ref={menuRef}
                className={`absolute right-2 z-20 w-36 rounded-lg border border-[#2a2440] bg-[#14111f] py-1 shadow-xl ${
                  menuAbove ? "bottom-full mb-1" : "top-full mt-1"
                }`}
              >
                <button
                  onClick={() => {
                    setRenameValue(entry.title || "");
                    setRenamingId(entry.id);
                    setMenuId(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-zinc-300 hover:bg-[#1e1a2e] transition-colors"
                >
                  <Pencil size={12} /> Rename
                </button>
                <button
                  onClick={() => handleDelete(entry.id)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-[#1e1a2e] transition-colors"
                >
                  <Trash2 size={12} /> Delete
                </button>
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
