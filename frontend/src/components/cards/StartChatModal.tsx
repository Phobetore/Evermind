import { Field } from "@/components/editor/Field";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { Modal } from "@/components/ui/Modal";
import { data } from "@/data";
import { useT } from "@/i18n/useT";
import { describeError } from "@/lib/errors";
import { newId } from "@/lib/utils";
import type { Character, Connection, Persona } from "@/types";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

export function StartChatModal({
  character,
  onClose,
}: {
  character: Character;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const t = useT();
  // Null until the list has come, which is when the choice can be made.
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [personaId, setPersonaId] = useState<string>("");
  const [connectionId, setConnectionId] = useState<string>("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailure, setLoadFailure] = useState<{ error: unknown } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Entered again after its answer was lost, it is the conversation made; another choice, another.
  const [clientId, setClientId] = useState(newId);

  useEffect(() => {
    Promise.all([
      data.personas.list(),
      data.connections ? data.connections.list() : Promise.resolve<Connection[]>([]),
    ])
      .then(([p, c]) => {
        setPersonas(p);
        setConnections(c);
        setPersonaId(p.find((x) => x.is_default)?.id ?? "");
        setConnectionId(c.find((x) => x.is_default)?.id ?? "");
      })
      // An empty list would say there is no persona to play, when there may be one
      // that a conversation started now would be played as.
      .catch((error) => setLoadFailure({ error }));
  }, [attempt]);

  function tryAgain() {
    setLoadFailure(null);
    setAttempt((n) => n + 1);
  }

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const convo = await data.conversations.create({
        character_id: character.id,
        persona_id: personaId || null,
        connection_id: connectionId || null,
        client_id: clientId,
      });
      navigate(`/chat/${convo.id}`);
    } catch (e) {
      setError(describeError(e, t, t("cards.startChatModal.startError")));
      setStarting(false);
    }
  }

  return (
    <Modal title={t("cards.startChatModal.title", { name: character.name })} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {loadFailure ? (
          <LoadFailure error={loadFailure.error} onRetry={tryAgain} />
        ) : (
          <>
            <Field label={t("chat.panel.youArePlaying")} hint={t("cards.startChatModal.personaHint")}>
              <select
                className="field"
                disabled={personas === null}
                value={personaId}
                onChange={(e) => {
                  setPersonaId(e.target.value);
                  setClientId(newId());
                }}
              >
                {personas === null && <option value="">{t("common.loading")}</option>}
                {/* With a persona marked, asking for none gets that persona all the same. */}
                {personas && !personas.some((p) => p.is_default) && (
                  <option value="">{t("cards.startChatModal.noPersonaOption")}</option>
                )}
                {(personas ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>

            {data.connections && (
              <Field label={t("connections.modelLabel")}>
                <select
                  className="field"
                  value={connectionId}
                  onChange={(e) => {
                    setConnectionId(e.target.value);
                    setClientId(newId());
                  }}
                >
                  {/* The connections come with the personas: null personas is loading. */}
                  {connections.length === 0 && (
                    <option value="">
                      {personas === null ? t("common.loading") : t("cards.startChatModal.noConnectionOption")}
                    </option>
                  )}
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} {c.model ? `· ${c.model}` : ""}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {personas !== null && data.connections && connections.length === 0 && (
              <p className="rounded-lg border border-ember-600/40 bg-ember-glow px-4 py-2.5 text-sm text-ember-300">
                {t("cards.startChatModal.noConnectionWarning")}
              </p>
            )}
          </>
        )}
        {error && (
          <p className="rounded-lg border border-blood/40 bg-blood/10 px-4 py-2.5 text-sm text-blood">
            {error}
          </p>
        )}

        <button
          className="btn btn-primary w-full"
          onClick={start}
          disabled={starting || personas === null}
        >
          {starting ? t("chat.openingScene") : t("cards.startChatModal.enterButton")}
        </button>
      </div>
    </Modal>
  );
}
