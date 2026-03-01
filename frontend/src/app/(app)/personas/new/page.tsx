"use client";

import PersonaForm from "@/components/personas/PersonaForm";
import PageContainer from "@/components/ui/PageContainer";
import { api } from "@/lib/api";
import type { UserPersona, UserPersonaCreate } from "@/types";

export default function NewPersonaPage() {
  async function handleCreate(data: UserPersonaCreate) {
    await api.post<UserPersona>("/user_personas", data);
  }

  return (
    <PageContainer>
      <h1 className="text-2xl font-bold mb-6">New Persona</h1>
      <PersonaForm onSubmit={handleCreate} />
    </PageContainer>
  );
}
