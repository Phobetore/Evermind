"use client";

import CharacterCard from "@/components/characters/CharacterCard";
import { api } from "@/lib/api";
import type { Character } from "@/types";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

export default function CharactersPage() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = search ? `?search=${encodeURIComponent(search)}` : "";
      const data = await api.get<Character[]>(`/characters${query}`);
      setCharacters(data);
    } catch {
      setCharacters([]);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleDelete(id: string) {
    if (!confirm("Delete this character?")) return;
    try {
      await api.delete(`/characters/${id}`);
      setCharacters((prev) => prev.filter((c) => c.id !== id));
    } catch {
      // ignore
    }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Characters</h1>
        <Link
          href="/characters/new"
          className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200"
        >
          + New Character
        </Link>
      </div>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search characters…"
        className="input mb-6 w-full max-w-sm"
      />

      {loading ? (
        <div className="text-zinc-500 text-sm">Loading…</div>
      ) : characters.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-zinc-400 text-lg mb-4">No characters yet</p>
          <p className="text-zinc-500 text-sm">
            Create your first AI character to get started.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {characters.map((char) => (
            <CharacterCard
              key={char.id}
              character={char}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
