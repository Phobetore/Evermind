import { CharacterForm } from "@/components/editor/CharacterForm";
import { data } from "@/data";
import { useT } from "@/i18n/useT";
import type { Character } from "@/types";
import { useEffect, useState } from "react";
import { useParams } from "react-router";

/** Keyed by the id: the form takes its fields from the card once, when it
 *  first appears, so another card needs a form of its own. */
export function EditCharacterPage() {
  const { id = "" } = useParams();
  return <EditCharacter key={id} id={id} />;
}

function EditCharacter({ id }: { id: string }) {
  const t = useT();
  const [character, setCharacter] = useState<Character | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    data.characters
      .get(id)
      .then(setCharacter)
      .catch((e) => setError(e.message));
  }, [id]);

  if (error) return <p className="p-10 text-blood">{error}</p>;
  if (!character) return <div className="p-10 text-mist animate-pulse-soft">{t("common.loading")}</div>;
  return <CharacterForm initial={character} />;
}
