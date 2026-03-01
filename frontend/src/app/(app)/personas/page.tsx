"use client";

import Card from "@/components/ui/Card";
import PageContainer from "@/components/ui/PageContainer";
import { api } from "@/lib/api";
import type { UserPersona } from "@/types";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Plus, Pencil, Trash2, Users } from "lucide-react";

export default function PersonasPage() {
  const [personas, setPersonas] = useState<UserPersona[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<UserPersona[]>("/user_personas");
      setPersonas(data);
    } catch {
      setPersonas([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleDelete(id: string) {
    if (!confirm("Delete this persona?")) return;
    try {
      await api.delete(`/user_personas/${id}`);
      setPersonas((prev) => prev.filter((p) => p.id !== id));
    } catch {
      // ignore
    }
  }

  return (
    <PageContainer>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">My Personas</h1>
        <Link
          href="/personas/new"
          className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500"
        >
          <Plus size={14} /> New Persona
        </Link>
      </div>

      <p className="text-zinc-400 text-sm mb-6">
        Create profiles that describe who you are in conversations.
        Characters will see this info and interact with you accordingly.
      </p>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="animate-pulse rounded-xl border border-border bg-surface p-5 h-32"
            />
          ))}
        </div>
      ) : personas.length === 0 ? (
        <div className="text-center py-12">
          <Users className="mx-auto mb-4 text-zinc-600" size={48} />
          <p className="text-zinc-400 text-lg mb-2">No personas yet</p>
          <p className="text-zinc-500 text-sm mb-4">
            Create a persona to give characters information about you.
          </p>
          <Link
            href="/personas/new"
            className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500"
          >
            <Plus size={14} /> Create your first persona
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {personas.map((persona) => (
            <Card key={persona.id} className="group relative">
              <div className="flex items-start gap-3">
                <PersonaAvatar persona={persona} />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">{persona.name}</div>
                  {persona.age && (
                    <div className="text-xs text-zinc-500 mt-0.5">
                      Age: {persona.age}
                    </div>
                  )}
                  {persona.physical_description && (
                    <p className="text-xs text-zinc-400 line-clamp-2 mt-1">
                      {persona.physical_description}
                    </p>
                  )}
                  {persona.personality && (
                    <p className="text-xs text-zinc-500 line-clamp-1 mt-1">
                      {persona.personality}
                    </p>
                  )}
                </div>
              </div>
              <div className="absolute top-3 right-3 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <Link
                  href={`/personas/${persona.id}`}
                  className="p-1.5 rounded-md hover:bg-surface-light text-zinc-400 hover:text-zinc-200 transition-colors"
                  title="Edit"
                >
                  <Pencil size={14} />
                </Link>
                <button
                  onClick={() => handleDelete(persona.id)}
                  className="p-1.5 rounded-md hover:bg-red-900/30 text-zinc-400 hover:text-red-400 transition-colors"
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </PageContainer>
  );
}

function PersonaAvatar({ persona }: { persona: UserPersona }) {
  if (persona.avatar_path) {
    return (
      <img
        src={`/api/user_personas/${persona.id}/avatar/file`}
        alt={persona.name}
        className="h-10 w-10 rounded-full object-cover shrink-0"
      />
    );
  }
  return (
    <div className="flex items-center justify-center h-10 w-10 rounded-full bg-violet-600 font-medium text-lg shrink-0">
      {persona.name.charAt(0).toUpperCase()}
    </div>
  );
}
