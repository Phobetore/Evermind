"use client";

import { api } from "@/lib/api";
import type { Character, MemoryItem } from "@/types";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Pin, Trash2 } from "lucide-react";

type MemoryType = "all" | "semantic" | "episodic" | "world";

export default function MemoryInspectorPage() {
  const params = useParams();
  const characterId = params?.id as string;

  const [character, setCharacter] = useState<Character | null>(null);
  const [allMemories, setAllMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<MemoryType>("all");
  const [showDeleted, setShowDeleted] = useState(false);
  const [worldState, setWorldState] = useState<Record<string, unknown> | null>(
    null
  );
  const [selectedMemory, setSelectedMemory] = useState<MemoryItem | null>(null);

  const loadMemories = useCallback(async () => {
    if (!characterId) return;
    const data = await api.get<MemoryItem[]>(
      `/characters/${characterId}/memories?include_deleted=true`
    );
    setAllMemories(data);
  }, [characterId]);

  // Client-side filtering (no effect → setState chain)
  const memories = useMemo(() => {
    let result = allMemories;
    if (typeFilter !== "all") {
      result = result.filter((m) => m.type === typeFilter);
    }
    if (!showDeleted) {
      result = result.filter((m) => !m.is_deleted);
    }
    return result;
  }, [allMemories, typeFilter, showDeleted]);

  // Initial load: character + memories + world state
  useEffect(() => {
    if (!characterId) return;
    Promise.all([
      api.get<Character>(`/characters/${characterId}`),
      api.get<MemoryItem[]>(
        `/characters/${characterId}/memories?include_deleted=true`
      ),
      api
        .get<{ state: Record<string, unknown> } | null>(
          `/characters/${characterId}/world_state`
        )
        .catch(() => null),
    ])
      .then(([char, mems, ws]) => {
        setCharacter(char);
        setAllMemories(mems);
        if (ws && "state" in ws) setWorldState(ws.state);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [characterId]);

  async function handlePin(memoryId: string) {
    await api.post(`/characters/${characterId}/memories/${memoryId}/pin`, {});
    await loadMemories();
  }

  async function handleUnpin(memoryId: string) {
    await api.post(`/characters/${characterId}/memories/${memoryId}/unpin`, {});
    await loadMemories();
  }

  async function handleForget(memoryId: string) {
    await api.post(
      `/characters/${characterId}/memories/forget?memory_id=${memoryId}`,
      {}
    );
    await loadMemories();
    setSelectedMemory(null);
  }

  if (loading) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Memory Inspector</h1>
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="animate-pulse h-20 rounded-xl bg-zinc-800"
            />
          ))}
        </div>
      </div>
    );
  }

  if (!character) {
    return (
      <div className="p-6 text-zinc-500">Character not found</div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">
            Memories — {character.name}
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            {memories.length} memor{memories.length === 1 ? "y" : "ies"}
          </p>
        </div>
        <a
          href={`/characters/${characterId}/edit`}
          className="text-sm text-blue-400 hover:text-blue-300"
        >
          <ArrowLeft size={14} className="inline" /> Back to editor
        </a>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        {(["all", "semantic", "episodic", "world"] as MemoryType[]).map(
          (t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                typeFilter === t
                  ? "bg-blue-500/20 text-blue-400 border border-blue-500/50"
                  : "bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-600"
              }`}
            >
              {t === "all" ? "All types" : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          )
        )}
        <label className="flex items-center gap-2 text-sm text-zinc-400 ml-auto">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(e) => setShowDeleted(e.target.checked)}
            className="rounded bg-zinc-800 border-zinc-600"
          />
          Show deleted
        </label>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Memory list */}
        <div className="lg:col-span-2 space-y-3">
          {memories.length === 0 && (
            <div className="text-center py-12 text-zinc-500">
              No memories found for this character.
            </div>
          )}
          {memories.map((mem) => (
            <button
              key={mem.id}
              onClick={() => setSelectedMemory(mem)}
              className={`w-full text-left rounded-xl border p-4 transition-colors ${
                selectedMemory?.id === mem.id
                  ? "border-blue-500 bg-blue-500/10"
                  : mem.is_deleted
                    ? "border-red-900/50 bg-red-950/20 opacity-60"
                    : "border-zinc-800 bg-zinc-900 hover:border-zinc-700"
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      mem.type === "semantic"
                        ? "bg-purple-500/20 text-purple-400"
                        : mem.type === "episodic"
                          ? "bg-green-500/20 text-green-400"
                          : "bg-yellow-500/20 text-yellow-400"
                    }`}
                  >
                    {mem.type}
                  </span>
                  {mem.is_deleted && (
                    <span className="text-xs text-red-500">deleted</span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                  <span>imp: {mem.importance.toFixed(2)}</span>
                  <span>·</span>
                  <span>conf: {mem.confidence.toFixed(2)}</span>
                </div>
              </div>
              <h3 className="font-medium text-sm">{mem.title}</h3>
              <p className="text-xs text-zinc-400 mt-1 line-clamp-2">
                {mem.content}
              </p>
              {mem.tags.length > 0 && (
                <div className="flex gap-1 mt-2">
                  {mem.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </button>
          ))}
        </div>

        {/* Detail panel */}
        <div className="space-y-4">
          {selectedMemory ? (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
              <h3 className="font-semibold mb-3">{selectedMemory.title}</h3>
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-xs text-zinc-500">Type</dt>
                  <dd>{selectedMemory.type}</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-500">Content</dt>
                  <dd className="text-zinc-300">{selectedMemory.content}</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-500">Importance</dt>
                  <dd>{selectedMemory.importance.toFixed(2)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-500">Confidence</dt>
                  <dd>{selectedMemory.confidence.toFixed(2)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-500">Created</dt>
                  <dd className="text-zinc-400">
                    {new Date(selectedMemory.created_at).toLocaleString()}
                  </dd>
                </div>
                {selectedMemory.last_referenced_at && (
                  <div>
                    <dt className="text-xs text-zinc-500">Last referenced</dt>
                    <dd className="text-zinc-400">
                      {new Date(
                        selectedMemory.last_referenced_at
                      ).toLocaleString()}
                    </dd>
                  </div>
                )}
                {selectedMemory.entities.length > 0 && (
                  <div>
                    <dt className="text-xs text-zinc-500">Entities</dt>
                    <dd className="text-zinc-400">
                      {selectedMemory.entities.join(", ")}
                    </dd>
                  </div>
                )}
              </dl>
              <div className="flex gap-2 mt-4">
                {!selectedMemory.is_deleted && (
                  <>
                    <button
                      onClick={() =>
                        selectedMemory.is_pinned
                          ? handleUnpin(selectedMemory.id)
                          : handlePin(selectedMemory.id)
                      }
                      className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-colors"
                    >
                      <Pin size={14} className="inline" /> {selectedMemory.is_pinned ? "Unpin" : "Pin"}
                    </button>
                    <button
                      onClick={() => handleForget(selectedMemory.id)}
                      className="px-3 py-1.5 text-xs rounded-lg bg-red-900/30 text-red-400 hover:bg-red-900/50 transition-colors"
                    >
                      <Trash2 size={14} className="inline" /> Forget
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 text-center text-sm text-zinc-500">
              Select a memory to view details
            </div>
          )}

          {/* World State */}
          {worldState && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
              <h3 className="font-semibold mb-3 text-sm">World State</h3>
              <pre className="text-xs text-zinc-400 whitespace-pre-wrap overflow-auto max-h-64">
                {JSON.stringify(worldState, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
