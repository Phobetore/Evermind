"use client";

import CharacterForm from "@/components/characters/CharacterForm";
import { api } from "@/lib/api";
import type { Character, CharacterCreate } from "@/types";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

export default function EditCharacterPage() {
  const params = useParams();
  const id = params?.id as string;
  const [character, setCharacter] = useState<Character | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    api
      .get<Character>(`/characters/${id}`)
      .then(setCharacter)
      .catch(() => setCharacter(null))
      .finally(() => setLoading(false));
  }, [id]);

  async function handleUpdate(data: CharacterCreate) {
    await api.put<Character>(`/characters/${id}`, data);
  }

  if (loading) return <div className="p-6 text-zinc-500">Loading…</div>;
  if (!character)
    return <div className="p-6 text-zinc-500">Character not found</div>;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Edit {character.name}</h1>
      <CharacterForm initial={character} onSubmit={handleUpdate} />
    </div>
  );
}
