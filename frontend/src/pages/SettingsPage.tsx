import { Field } from "@/components/editor/Field";
import { useAccess } from "@/components/layout/Access";
import { LanguageSelect } from "@/components/layout/LanguageSelect";
import { ConnectionForm } from "@/components/settings/ConnectionForm";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { Tag } from "@/components/ui/Tag";
import { data, type DataSource } from "@/data";
import { useT } from "@/i18n/useT";
import { describeError } from "@/lib/errors";
import { isNewer, latestRelease, type Release } from "@/lib/releases";
import type { Connection, Installation, Settings } from "@/types";
import { Cable, Loader2, LogOut, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export function SettingsPage() {
  const t = useT();
  const { status: accessStatus } = useAccess();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [editing, setEditing] = useState<Connection | "new" | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadFailure, setLoadFailure] = useState<{ error: unknown } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorLine = useRef<HTMLParagraphElement>(null);

  const load = useCallback(() => {
    Promise.all([
      data.connections?.list().then(setConnections),
      data.settings.get().then(setSettings),
    ]).then(() => setLoadFailure(null), (error) => setLoadFailure({ error }));
  }, []);

  useEffect(load, [load]);

  // The page scrolls inside <main>, and the line is at the top of it.
  useEffect(() => {
    if (saveError) errorLine.current?.scrollIntoView({ block: "nearest" });
  }, [saveError]);

  function flashSaved() {
    setSavedFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setSavedFlash(false), 1500);
  }

  /** The controls hold what is stored, so a save that fails and says nothing
   *  looks like a control that will not move. */
  async function attempt(save: () => Promise<void>) {
    setSaveError(null);
    try {
      await save();
    } catch (e) {
      setSaveError(describeError(e, t));
    }
  }

  function saveSettings(patch: Partial<Settings>) {
    return attempt(async () => {
      setSettings(await data.settings.update(patch));
      flashSaved();
    });
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8 animate-rise">
        <h1 className="font-display text-3xl font-semibold">{t("nav.settings")}</h1>
        <p className="mt-1 text-mist">{t("settings.subtitle")}</p>
      </header>

      {saveError && (
        <p
          ref={errorLine}
          role="alert"
          className="mb-6 rounded-lg border border-blood/40 bg-blood/10 px-4 py-2.5 text-sm text-blood"
        >
          {saveError}
        </p>
      )}

      {/* Not in place of the page: what needs no reading still works. */}
      {loadFailure && (
        <div className="mb-6">
          <LoadFailure error={loadFailure.error} onRetry={load} />
        </div>
      )}

      {/* Where the sidebar, and the choice in it, is not shown. */}
      <section className="mb-10 grid gap-4 sm:grid-cols-2 md:hidden">
        <Field label={t("nav.language")}>
          <LanguageSelect />
        </Field>
      </section>

      {/* Connections: only an edition that keeps its own models has them. */}
      {data.connections && (
        <section className="mb-10">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="ui-label">{t("settings.connectionsTitle")}</h2>
            <button className="btn btn-primary !py-2 text-sm" onClick={() => setEditing("new")}>
              <Plus className="h-4 w-4" /> {t("settings.addConnection")}
            </button>
          </div>

          {connections === null ? (
            !loadFailure && <div className="text-mist animate-pulse-soft">{t("common.loading")}</div>
          ) : connections.length === 0 ? (
            <EmptyState icon={Cable} title={t("settings.emptyState.title")}>
              {t("settings.emptyState.body")}
            </EmptyState>
          ) : (
            <div className="stagger flex flex-col gap-3">
              {connections.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setEditing(c)}
                  className="panel flex items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:border-ember-600/40"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-display font-semibold">{c.name}</h3>
                      {c.is_default && <Tag tone="ember">{t("settings.defaultTag")}</Tag>}
                    </div>
                    <p className="mt-0.5 truncate text-sm text-mist">
                      {c.provider === "anthropic" ? "Anthropic" : "OpenAI-compatible"} ·{" "}
                      {c.model || t("settings.noModel")} · {c.base_url}
                    </p>
                  </div>
                  <span className="shrink-0 font-mono text-xs text-mist-dim">
                    {c.api_key_set ? t("settings.keyHint", { hint: c.api_key_hint }) : t("settings.noKey")}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Reply length + history window */}
      {settings && (
        <section className="mb-10 grid gap-4 sm:grid-cols-2">
          <Field
            label={t("settings.replyLengthLabel")}
            hint={t("settings.replyLengthHint")}
          >
            <select
              className="field"
              value={settings.reply_length}
              onChange={(e) => saveSettings({ reply_length: e.target.value as Settings["reply_length"] })}
            >
              <option value="short">{t("settings.replyLengthOptions.short")}</option>
              <option value="medium">{t("settings.replyLengthOptions.medium")}</option>
              <option value="long">{t("settings.replyLengthOptions.long")}</option>
            </select>
          </Field>
          <Field
            label={t("settings.historyLimitLabel")}
            hint={t("settings.historyLimitHint")}
          >
            <input
              type="number"
              className="field"
              min={4}
              max={200}
              key={settings.history_limit}
              defaultValue={settings.history_limit}
              onBlur={(e) => {
                const v = Math.max(4, Math.min(200, Math.round(Number(e.target.value)) || 24));
                e.target.value = String(v);
                if (v !== settings.history_limit) saveSettings({ history_limit: v });
              }}
            />
          </Field>
          <Field
            label={t("settings.passageBudgetLabel")}
            hint={t("settings.passageBudgetHint")}
          >
            <input
              type="number"
              className="field"
              min={0}
              max={4000}
              key={settings.passage_budget}
              defaultValue={settings.passage_budget}
              onBlur={(e) => {
                const v = Math.max(0, Math.min(4000, Math.round(Number(e.target.value)) || 0));
                e.target.value = String(v);
                if (v !== settings.passage_budget) saveSettings({ passage_budget: v });
              }}
            />
          </Field>
        </section>
      )}

      {/* Memory */}
      {settings && (
        <section className="mb-10">
          <h2 className="ui-label mb-2">{t("settings.autoMemoryTitle")}</h2>
          <label className="touch-target flex cursor-pointer items-start gap-3 text-sm text-parchment-dim">
            <input
              type="checkbox"
              checked={settings.auto_memory}
              onChange={(e) => saveSettings({ auto_memory: e.target.checked })}
              className="mt-0.5 h-4 w-4 accent-[#e29a3e]"
            />
            <span>
              {t("settings.autoMemoryHint.before")}{" "}
              <em>{t("settings.autoMemoryHint.emphasis")}</em>{" "}
              {t("settings.autoMemoryHint.after")}
            </span>
          </label>
        </section>
      )}

      {/* Global instructions */}
      {settings && (
        <section>
          <h2 className="ui-label mb-2">{t("settings.globalInstructionsTitle")}</h2>
          <p className="mb-3 text-sm leading-relaxed text-mist">
            {t("settings.globalInstructionsHint.part1")}{" "}
            <em>{t("settings.globalInstructionsHint.emphasis")}</em>{" "}
            {t("settings.globalInstructionsHint.part2")}{" "}
            <em>{t("settings.globalInstructionsHint.emphasis")}</em>{" "}
            {t("settings.globalInstructionsHint.part3")}
          </p>
          <GlobalInstructions
            initial={settings.global_instructions}
            onSave={(v) => saveSettings({ global_instructions: v })}
          />
          {savedFlash && <p className="mt-2 text-sm text-moss animate-fade">{t("settings.savedFlash")}</p>}
        </section>
      )}

      {data.access && accessStatus?.enabled && <Access />}

      {data.updates && settings && (
        <About
          updates={data.updates}
          asks={settings.update_check}
          onAsksChange={(update_check) => saveSettings({ update_check })}
        />
      )}

      {editing && data.connections && (
        <ConnectionForm
          source={data.connections}
          connection={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function GlobalInstructions({
  initial,
  onSave,
}: {
  initial: string;
  onSave: (value: string) => void;
}) {
  const t = useT();
  const [value, setValue] = useState(initial);
  return (
    <div>
      <textarea
        className="field min-h-32"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t("settings.globalInstructionsPlaceholder")}
      />
      <button className="btn btn-ghost mt-2" onClick={() => onSave(value)} disabled={value === initial}>
        {t("settings.saveInstructions")}
      </button>
    </div>
  );
}

/** Signing out, for the devices that had to give the password to get in. */
function Access() {
  const t = useT();
  const { signOut: leave } = useAccess();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut(everywhere: boolean) {
    if (everywhere && !confirm(t("settings.access.logoutEverywhereConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      // Signed out, the device meets the gate, which takes it to the login.
      await leave(everywhere);
    } catch (e) {
      setError(describeError(e, t));
      setBusy(false);
    }
  }

  return (
    <section className="mt-10">
      <h2 className="ui-label mb-2">{t("settings.access.title")}</h2>
      <div className="panel px-5 py-4">
        <p className="text-sm leading-relaxed text-mist">{t("settings.access.hint")}</p>
        <div className="mt-3 flex flex-wrap gap-3">
          <button
            type="button"
            className="btn btn-ghost !py-1.5 text-sm"
            onClick={() => signOut(false)}
            disabled={busy}
          >
            <LogOut className="h-4 w-4" />
            {t("settings.access.logout")}
          </button>
          <button
            type="button"
            className="btn btn-ghost !py-1.5 text-sm"
            onClick={() => signOut(true)}
            disabled={busy}
          >
            {t("settings.access.logoutEverywhere")}
          </button>
        </div>
        {error && <p className="mt-3 text-sm text-blood">{error}</p>}
      </div>
    </section>
  );
}

/** Version, and a way back to the project. The app had neither, so nobody
 *  running it could tell what they were on, report a bug against it, or find
 *  where it comes from. It also says when a newer release exists, since a
 *  self-hosted app has no other way of telling you. */
function About({
  updates,
  asks,
  onAsksChange,
}: {
  updates: NonNullable<DataSource["updates"]>;
  /** Whether the page asks GitHub on its own when it opens. */
  asks: boolean;
  onAsksChange: (asks: boolean) => void;
}) {
  const t = useT();
  const [installed, setInstalled] = useState<Installation | null>(null);
  const [latest, setLatest] = useState<Release | null>(null);
  const [checking, setChecking] = useState(false);
  // What the last press of the button came back with. Null until pressed, so
  // an ordinary page load says nothing at all.
  const [verdict, setVerdict] = useState<"current" | "unreachable" | null>(null);

  useEffect(() => {
    updates.get().then(setInstalled).catch(() => {});
  }, [updates]);

  // Not reaching GitHub is no news here: only the button owes an answer.
  useEffect(() => {
    if (asks) latestRelease().then(setLatest).catch(() => {});
  }, [asks]);

  async function checkNow() {
    setChecking(true);
    setVerdict(null);
    try {
      const release = await latestRelease();
      setLatest(release);
      // Nothing to say when there is an update: the notice above says it.
      if (!isNewer(release.version, installed?.current ?? "")) setVerdict("current");
    } catch {
      setVerdict("unreachable");
    }
    setChecking(false);
  }

  const update = latest && installed && isNewer(latest.version, installed.current) ? latest : null;

  return (
    <section className="mt-10">
      <h2 className="ui-label mb-2">{t("settings.about.title")}</h2>
      <div className="panel px-5 py-4">
        <p className="text-sm text-mist">
          Evermind {installed?.current ?? "—"}
        </p>

        {update && (
          <div className="mt-3 rounded-xl border border-ember-500/40 bg-ember-glow px-4 py-3">
            <p className="text-sm font-semibold text-ember-300">
              {t("settings.about.updateAvailable").replace("{version}", update.version)}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-mist">
              {t("settings.about.updateHint")}
            </p>
            <code className="mt-2 block overflow-x-auto rounded-lg border border-ink-600 bg-ink-950/60 px-3 py-2 text-xs text-parchment-dim">
              {installed?.command}
            </code>
            {update.url && (
              <a
                className="mt-2 inline-block text-sm text-ember-400 hover:text-ember-300"
                href={update.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                {t("settings.about.releaseNotes")}
              </a>
            )}
          </div>
        )}

        <p className="mt-2 text-sm leading-relaxed text-mist">
          {t("settings.about.starHint")}
        </p>
        <div className="mt-3 flex flex-wrap gap-4 text-sm pointer-coarse:gap-y-6">
          <a
            className="touch-target text-ember-400 hover:text-ember-300"
            href="https://github.com/Phobetore/Evermind"
            target="_blank"
            rel="noreferrer noopener"
          >
            {t("settings.about.projectLink")}
          </a>
          <a
            className="touch-target text-mist hover:text-parchment"
            href="https://github.com/Phobetore/Evermind/issues/new/choose"
            target="_blank"
            rel="noreferrer noopener"
          >
            {t("settings.about.reportLink")}
          </a>
        </div>

        <div className="mt-4 border-t border-ink-700 pt-3">
          <label className="touch-target flex cursor-pointer items-start gap-3 text-sm text-mist">
            <input
              type="checkbox"
              checked={asks}
              onChange={(e) => onAsksChange(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[#e29a3e]"
            />
            <span>{t("settings.about.checkHint")}</span>
          </label>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn btn-ghost !py-1.5 text-sm"
              onClick={checkNow}
              disabled={checking || !installed}
            >
              {checking ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {t("settings.about.checkNow")}
            </button>
            {verdict === "current" && (
              <span className="text-sm text-moss">{t("settings.about.upToDate")}</span>
            )}
            {verdict === "unreachable" && (
              <span className="text-sm text-mist-dim">{t("settings.about.unreachable")}</span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
