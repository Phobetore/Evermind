"use client";

import { api } from "@/lib/api";
import type { Character, Conversation, UserPersona } from "@/types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import CharacterAvatar from "@/components/ui/CharacterAvatar";
import PageContainer from "@/components/ui/PageContainer";
import { X } from "lucide-react";

export default function ChatIndexPage() {
  const router = useRouter();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [personas, setPersonas] = useState<UserPersona[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCharId, setSelectedCharId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<Character[]>("/characters").catch(() => []),
      api.get<UserPersona[]>("/user_personas").catch(() => []),
    ]).then(([chars, pers]) => {
      setCharacters(chars);
      setPersonas(pers);
      setLoading(false);
    });
  }, []);

  async function startChat(characterId: string, personaId: string | null) {
    try {
      const conv = await api.post<Conversation>("/conversations", {
        character_id: characterId,
        title: "New conversation",
        user_persona_id: personaId,
      });
      router.push(`/chat/${conv.id}`);
    } catch {
      // ignore
    }
  }

  function handleCharacterClick(characterId: string) {
    if (personas.length === 0) {
      // No personas — start directly
      startChat(characterId, null);
    } else {
      // Show persona picker
      setSelectedCharId(characterId);
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
                onClick={() => handleCharacterClick(char.id)}
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

      {/* Persona selection modal */}
      {selectedCharId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-xl mx-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Choose a Persona</h2>
              <button
                onClick={() => setSelectedCharId(null)}
                className="text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                <X size={18} />
              </button>
            </div>
            <p className="text-sm text-zinc-400 mb-4">
              Select a persona to use in this conversation, or continue without one.
            </p>
            <div className="space-y-2 max-h-64 overflow-auto">
              {personas.map((persona) => (
                <button
                  key={persona.id}
                  onClick={() => {
                    setSelectedCharId(null);
                    startChat(selectedCharId, persona.id);
                  }}
                  className="w-full text-left rounded-lg border border-border bg-surface-light p-3 transition-colors hover:border-violet-500/30"
                >
                  <div className="flex items-center gap-3">
                    {persona.avatar_path ? (
                      <img
                        src={`/api/user_personas/${persona.id}/avatar/file`}
                        alt={persona.name}
                        className="h-8 w-8 rounded-full object-cover shrink-0"
                      />
                    ) : (
                      <div className="flex items-center justify-center h-8 w-8 rounded-full bg-violet-600 font-medium text-sm shrink-0">
                        {persona.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm">{persona.name}</div>
                      {persona.age && (
                        <span className="text-xs text-zinc-500">
                          Age: {persona.age}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
            <button
              onClick={() => {
                const charId = selectedCharId;
                setSelectedCharId(null);
                startChat(charId, null);
              }}
              className="w-full mt-3 rounded-lg border border-border px-4 py-2.5 text-sm text-zinc-300 transition-colors hover:bg-surface-light"
            >
              Continue without a persona
            </button>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
