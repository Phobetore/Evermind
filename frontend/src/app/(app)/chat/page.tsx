"use client";

import { api } from "@/lib/api";
import type { Character, Conversation } from "@/types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import CharacterAvatar from "@/components/ui/CharacterAvatar";
import PageContainer from "@/components/ui/PageContainer";

export default function ChatIndexPage() {
  const router = useRouter();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<Character[]>("/characters")
      .then(setCharacters)
      .catch(() => setCharacters([]))
      .finally(() => setLoading(false));
  }, []);

  async function startChat(characterId: string) {
    try {
      const conv = await api.post<Conversation>("/conversations", {
        character_id: characterId,
        title: "New conversation",
      });
      router.push(`/chat/${conv.id}`);
    } catch {
      // ignore
    }
  }

  if (loading) return <div className="p-6 text-zinc-500">Loading…</div>;

  return (
    <PageContainer>
      <h1 className="text-2xl font-bold mb-6">Chat</h1>

      {characters.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-zinc-400 text-lg mb-4">No characters available</p>
          <Link
            href="/characters/new"
            className="text-violet-400 hover:underline"
          >
            Create a character first
          </Link>
        </div>
      ) : (
        <div>
          <p className="text-zinc-400 text-sm mb-4">
            Select a character to start a conversation:
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {characters.map((char) => (
              <button
                key={char.id}
                onClick={() => startChat(char.id)}
                className="text-left rounded-xl border border-border bg-surface p-4 transition-colors hover:border-violet-500/30 hover:bg-surface-light"
              >
                <div className="flex items-center gap-3">
                  <CharacterAvatar name={char.name} />
                  <div>
                    <div className="font-medium">{char.name}</div>
                    {char.summary && (
                      <p className="text-xs text-zinc-400 line-clamp-1 mt-0.5">
                        {char.summary}
                      </p>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </PageContainer>
  );
}
