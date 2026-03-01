"use client";

import PersonaForm from "@/components/personas/PersonaForm";
import PageContainer from "@/components/ui/PageContainer";
import { api } from "@/lib/api";
import type { UserPersona, UserPersonaUpdate } from "@/types";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

export default function EditPersonaPage() {
  const params = useParams();
  const personaId = params?.personaId as string;
  const [persona, setPersona] = useState<UserPersona | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!personaId) return;
    api
      .get<UserPersona>(`/user_personas/${personaId}`)
      .then(setPersona)
      .catch(() => setPersona(null))
      .finally(() => setLoading(false));
  }, [personaId]);

  async function handleUpdate(data: UserPersonaUpdate) {
    await api.patch<UserPersona>(`/user_personas/${personaId}`, data);
  }

  if (loading) return <div className="p-6 text-zinc-500">Loading…</div>;
  if (!persona) return <div className="p-6 text-zinc-500">Persona not found</div>;

  return (
    <PageContainer>
      <h1 className="text-2xl font-bold mb-6">Edit Persona</h1>
      <PersonaForm initial={persona} onSubmit={handleUpdate} />
    </PageContainer>
  );
}
