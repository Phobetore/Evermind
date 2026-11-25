import { data, type AiSaved, type ModelUpdate } from "@/data";
import type { Translate } from "@/i18n/I18nProvider";
import { useT } from "@/i18n/useT";
import { describeError } from "@/lib/errors";
import type { Ai } from "@/types";
import { useState } from "react";

/** `text` with the first `bold` in it set in bold: the figure or the name a sentence is about. */
export function Bolded({ text, bold }: { text: string; bold: string }) {
  const at = bold ? text.indexOf(bold) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <b className="font-semibold text-parchment">{bold}</b>
      {text.slice(at + bold.length)}
    </>
  );
}

/** What the server read of the size, said as it was read: loaded by a server at home, set to be
 *  loaded, or announced by a service online, where nothing is loaded. */
function readSentence(ai: Ai, t: Translate): string {
  const vars = { service: ai.service.name, tokens: ai.context.read ?? 0 };
  if (ai.context.read_kind === "configured") return t("ai.notice.configured", vars);
  return t(ai.service.local ? "ai.notice.served" : "ai.notice.announced", vars);
}

type Done = { id: string; line: string };

/** The notices of the AIs it is given, with their buttons. Settings passes the migrated AIs whose
 *  `notices` is not empty; an AI's page passes [that AI] with `own`. Nothing applies by itself: each
 *  button is one save, and the line that says what it did stays while the page is open, even once
 *  the AI has no notice left to be passed for. */
export function MigrationNotice({ ais, onChanged, own = false }: {
  ais: Ai[];
  onChanged(ai: AiSaved): void;
  /** On the AI's own page: it is not named, it is the page's. */
  own?: boolean;
}) {
  const t = useT();
  const [done, setDone] = useState<Done[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null);

  async function act(ai: Ai, change: ModelUpdate, line: string) {
    if (!data.connections || busy) return;
    setBusy(ai.id);
    setFailed(null);
    try {
      const saved = await data.connections.models.update(ai.id, change);
      setDone((before) => [...before, { id: ai.id, line }]);
      onChanged(saved);
    } catch (error) {
      setFailed({ id: ai.id, message: describeError(error, t) });
    } finally {
      setBusy(null);
    }
  }

  const shown = ais.filter((ai) => ai.notices.length > 0);
  // The lines of AIs no longer passed (their notices all answered) stay, in the order they came.
  const gone = done.filter((d) => !shown.some((ai) => ai.id === d.id));
  if (shown.length === 0 && gone.length === 0) return null;

  return (
    <div className="mb-4 flex flex-col gap-3">
      {gone.map((d, i) => (
        <p key={`${d.id}-${i}`} role="status" className="rounded-xl border border-moss/40 bg-moss/10 px-4 py-3 text-sm text-parchment-dim">
          {d.line}
        </p>
      ))}
      {shown.map((ai) => {
        const tokens = (count: number) => t("ai.notice.tokens", { count });
        return (
          <div key={ai.id} className="flex flex-col gap-3">
            {done.filter((d) => d.id === ai.id).map((d, i) => (
              <p key={i} role="status" className="rounded-xl border border-moss/40 bg-moss/10 px-4 py-3 text-sm text-parchment-dim">
                {d.line}
              </p>
            ))}
            <div className="rounded-xl border border-ember-500/40 bg-ember-glow px-4 py-3 text-sm leading-relaxed text-parchment-dim">
              {own ? (
                ai.migrated && <p>{t("ai.notice.onPage")}</p>
              ) : (
                <p>
                  <Bolded text={t("ai.notice.broughtOver", { name: ai.name })} bold={ai.name} />{" "}
                  {t("ai.notice.against", { count: ai.notices.length })}
                </p>
              )}
              <ul className="mt-2 flex flex-col gap-3">
                {ai.notices.includes("follow_server") && ai.context.own !== null && (
                  <li>
                    <p>
                      <Bolded text={t("ai.notice.ownContext", { tokens: tokens(ai.context.own) })} bold={tokens(ai.context.own)} />{" "}
                      {readSentence(ai, t)}
                    </p>
                    <button
                      type="button"
                      className="btn btn-ghost mt-2 max-w-full whitespace-normal !py-1.5 text-sm"
                      disabled={busy !== null}
                      onClick={() => act(ai, { context_own: null },
                        t("ai.notice.followed", { name: ai.name, tokens: ai.context.own ?? 0 }))}
                    >
                      {t("ai.notice.followServer")}
                    </button>
                  </li>
                )}
                {ai.notices.includes("let_evermind") && ai.reply_cap.tokens !== null && (
                  <li>
                    <p>
                      <Bolded text={t("ai.notice.ownCap", { tokens: tokens(ai.reply_cap.tokens) })} bold={tokens(ai.reply_cap.tokens)} />
                    </p>
                    <button
                      type="button"
                      className="btn btn-ghost mt-2 max-w-full whitespace-normal !py-1.5 text-sm"
                      disabled={busy !== null}
                      onClick={() => act(ai, { reply_cap: { mode: "auto" } }, t("ai.notice.capLifted", { name: ai.name }))}
                    >
                      {t("ai.notice.letEvermind")}
                    </button>
                  </li>
                )}
              </ul>
              <button
                type="button"
                className="btn btn-ghost mt-3 max-w-full whitespace-normal !py-1.5 text-sm"
                disabled={busy !== null}
                onClick={() => act(ai, { notices_kept: true }, t("ai.notice.kept", { name: ai.name }))}
              >
                {t("ai.notice.keepAll")}
              </button>
              {failed?.id === ai.id && <p role="alert" className="mt-2 text-sm text-blood">{failed.message}</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
