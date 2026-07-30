"use client";

import { Field } from "@/components/editor/Field";
import { Modal } from "@/components/ui/Modal";
import { useT } from "@/i18n/useT";
import { api } from "@/lib/api";
import type { Character, Connection, Conversation, Persona, Settings } from "@/types";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export function StartChatModal({
  character,
  onClose,
}: {
  character: Character;
  onClose: () => void;
}) {
  const router = useRouter();
  const t = useT();
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [personaId, setPersonaId] = useState<string>("");
  const [connectionId, setConnectionId] = useState<string>("");
  const [greetingIndex, setGreetingIndex] = useState(0);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<Persona[]>("/api/personas"),
      api.get<Connection[]>("/api/connections"),
      api.get<Settings>("/api/settings"),
    ]).then(([p, c, s]) => {
      setPersonas(p);
      setConnections(c);
      setPersonaId(s.default_persona_id ?? p.find((x) => x.is_default)?.id ?? "");
      setConnectionId(s.default_connection_id ?? c.find((x) => x.is_default)?.id ?? "");
    });
  }, []);

  const greetings = [character.greeting, ...character.alternate_greetings].filter(
    (g) => g && g.trim(),
  );

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const convo = await api.post<Conversation>("/api/conversations", {
        character_id: character.id,
        persona_id: personaId || null,
        connection_id: connectionId || null,
        greeting_index: greetingIndex,
      });
      router.push(`/chat/${convo.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("cards.startChatModal.startError"));
      setStarting(false);
    }
  }

  return (
    <Modal title={t("cards.startChatModal.title", { name: character.name })} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Field label={t("chat.panel.youArePlaying")} hint={t("cards.startChatModal.personaHint")}>
          <select
            className="field"
            value={personaId}
            onChange={(e) => setPersonaId(e.target.value)}
          >
            <option value="">{t("cards.startChatModal.noPersonaOption")}</option>
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t("connections.modelLabel")}>
          <select
            className="field"
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
          >
            {connections.length === 0 && (
              <option value="">{t("cards.startChatModal.noConnectionOption")}</option>
            )}
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} {c.model ? `· ${c.model}` : ""}
              </option>
            ))}
          </select>
        </Field>

        {greetings.length > 1 && (
          <Field label={t("characters.detail.openingHeading")}>
            <select
              className="field"
              value={greetingIndex}
              onChange={(e) => setGreetingIndex(Number(e.target.value))}
            >
              {greetings.map((g, i) => (
                <option key={i} value={i}>
                  {i === 0
                    ? t("cards.startChatModal.mainGreetingOption")
                    : t("cards.startChatModal.alternateGreetingOption", { index: i })}{" "}
                  : {g.slice(0, 60)}…
                </option>
              ))}
            </select>
          </Field>
        )}

        {connections.length === 0 && (
          <p className="rounded-lg border border-ember-600/40 bg-ember-glow px-4 py-2.5 text-sm text-ember-300">
            {t("cards.startChatModal.noConnectionWarning")}
          </p>
        )}
        {error && (
          <p className="rounded-lg border border-blood/40 bg-blood/10 px-4 py-2.5 text-sm text-blood">
            {error}
          </p>
        )}

        <button className="btn btn-primary w-full" onClick={start} disabled={starting}>
          {starting ? t("chat.openingScene") : t("cards.startChatModal.enterButton")}
        </button>
      </div>
    </Modal>
  );
}
