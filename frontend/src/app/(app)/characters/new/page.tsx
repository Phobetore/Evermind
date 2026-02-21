"use client";

import CharacterForm from "@/components/characters/CharacterForm";
import { api } from "@/lib/api";
import type { Character, CharacterCreate } from "@/types";

export default function NewCharacterPage() {
  async function handleCreate(data: CharacterCreate) {
    await api.post<Character>("/characters", data);
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">New Character</h1>
      <CharacterForm onSubmit={handleCreate} />
    </div>
  );
}
