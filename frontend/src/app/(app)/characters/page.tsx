"use client";

import CharacterCard from "@/components/characters/CharacterCard";
import { CharacterCardSkeleton } from "@/components/ui/Skeleton";
import { api } from "@/lib/api";
import type { Character } from "@/types";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Upload, Plus } from "lucide-react";

export default function CharactersPage() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  async function handleExport(id: string) {
    try {
      const data = await api.get<Record<string, unknown>>(
        `/characters/${id}/export`
      );
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const char = characters.find((c) => c.id === id);
      a.download = `${char?.name ?? "character"}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("Export failed");
    }
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      await api.post<Character>("/characters/import", json);
      await load();
    } catch {
      alert("Import failed — invalid character file");
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Characters</h1>
        <div className="flex items-center gap-3">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 rounded-lg border border-[#2a2440] px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-[#1e1a2e]"
          >
            <Upload size={14} /> Import
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleImport}
          />
          <Link
            href="/characters/new"
            className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500"
          >
            <Plus size={14} /> New Character
          </Link>
        </div>
      </div>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search characters…"
        className="input mb-6 w-full max-w-sm"
      />

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {[1, 2, 3, 4].map((i) => (
            <CharacterCardSkeleton key={i} />
          ))}
        </div>
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
              onExport={handleExport}
            />
          ))}
        </div>
      )}
    </div>
  );
}
