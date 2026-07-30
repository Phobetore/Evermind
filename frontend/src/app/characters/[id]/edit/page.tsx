"use client";

import { CharacterForm } from "@/components/editor/CharacterForm";
import { useT } from "@/i18n/useT";
import { api } from "@/lib/api";
import type { Character } from "@/types";
import { use, useEffect, useState } from "react";

export default function EditCharacterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useT();
  const [character, setCharacter] = useState<Character | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Character>(`/api/characters/${id}`)
      .then(setCharacter)
      .catch((e) => setError(e.message));
  }, [id]);

  if (error) return <p className="p-10 text-blood">{error}</p>;
  if (!character) return <div className="p-10 text-mist animate-pulse-soft">{t("common.loading")}</div>;
  return <CharacterForm initial={character} />;
}
