"use client";

import { Field } from "@/components/editor/Field";
import { ConnectionForm } from "@/components/settings/ConnectionForm";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tag } from "@/components/ui/Tag";
import { useT } from "@/i18n/useT";
import { api } from "@/lib/api";
import type { Connection, Persona, Settings, UpdateStatus } from "@/types";
import { Cable, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export default function SettingsPage() {
  const t = useT();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [editing, setEditing] = useState<Connection | "new" | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    api.get<Connection[]>("/api/connections").then(setConnections);
    api.get<Persona[]>("/api/personas").then(setPersonas);
    api.get<Settings>("/api/settings").then(setSettings);
  }, []);

  useEffect(load, [load]);

  async function saveSettings(patch: Partial<Settings>) {
    const updated = await api.put<Settings>("/api/settings", patch);
    setSettings(updated);
    setSavedFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setSavedFlash(false), 1500);
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8 animate-rise">
        <h1 className="font-display text-3xl font-semibold">{t("nav.settings")}</h1>
        <p className="mt-1 text-mist">{t("settings.subtitle")}</p>
      </header>

      {/* Connections */}
      <section className="mb-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="ui-label">{t("settings.connectionsTitle")}</h2>
          <button className="btn btn-primary !py-2 text-sm" onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" /> {t("settings.addConnection")}
          </button>
        </div>

        {connections === null ? (
          <div className="text-mist animate-pulse-soft">{t("common.loading")}</div>
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

      {/* Defaults */}
      {settings && (
        <section className="mb-10 grid gap-4 sm:grid-cols-2">
          <Field label={t("settings.defaultPersonaLabel")}>
            <select
              className="field"
              value={settings.default_persona_id ?? ""}
              onChange={(e) => saveSettings({ default_persona_id: e.target.value || null })}
            >
              <option value="">{t("settings.noneOption")}</option>
              {personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("settings.defaultConnectionLabel")}>
            <select
              className="field"
              value={settings.default_connection_id ?? ""}
              onChange={(e) => saveSettings({ default_connection_id: e.target.value || null })}
            >
              <option value="">{t("settings.firstAvailableOption")}</option>
              {(connections ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
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
          <label className="flex cursor-pointer items-start gap-3 text-sm text-parchment-dim">
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

      <About />

      {editing && (
        <ConnectionForm
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

/** Version, and a way back to the project. The app had neither, so nobody
 *  running it could tell what they were on, report a bug against it, or find
 *  where it comes from. It also says when a newer release exists, since a
 *  self-hosted app has no other way of telling you. */
function About() {
  const t = useT();
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    api.get<UpdateStatus>("/api/update").then(setStatus).catch(() => setStatus(null));
  }, []);

  async function setChecking(enabled: boolean) {
    // Answer the click straight away; the release lookup behind it can take a
    // few seconds and must not make the checkbox feel stuck.
    setStatus((prev) => (prev ? { ...prev, enabled } : prev));
    await api.put("/api/settings", { update_check: enabled });
    api.get<UpdateStatus>("/api/update").then(setStatus).catch(() => {});
  }

  return (
    <section className="mt-10">
      <h2 className="ui-label mb-2">{t("settings.about.title")}</h2>
      <div className="panel px-5 py-4">
        <p className="text-sm text-mist">
          Evermind {status?.current ?? "—"}
        </p>

        {status?.update_available && (
          <div className="mt-3 rounded-xl border border-ember-500/40 bg-ember-glow px-4 py-3">
            <p className="text-sm font-semibold text-ember-300">
              {t("settings.about.updateAvailable").replace("{version}", status.latest ?? "")}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-mist">
              {t("settings.about.updateHint")}
            </p>
            <code className="mt-2 block overflow-x-auto rounded-lg border border-ink-600 bg-ink-950/60 px-3 py-2 text-xs text-parchment-dim">
              {status.command}
            </code>
            {status.url && (
              <a
                className="mt-2 inline-block text-sm text-ember-400 hover:text-ember-300"
                href={status.url}
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
        <div className="mt-3 flex flex-wrap gap-4 text-sm">
          <a
            className="text-ember-400 hover:text-ember-300"
            href="https://github.com/Phobetore/Evermind"
            target="_blank"
            rel="noreferrer noopener"
          >
            {t("settings.about.projectLink")}
          </a>
          <a
            className="text-mist hover:text-parchment"
            href="https://github.com/Phobetore/Evermind/issues/new/choose"
            target="_blank"
            rel="noreferrer noopener"
          >
            {t("settings.about.reportLink")}
          </a>
        </div>

        <label className="mt-4 flex cursor-pointer items-start gap-3 border-t border-ink-700 pt-3 text-sm text-mist">
          <input
            type="checkbox"
            checked={status?.enabled ?? false}
            onChange={(e) => setChecking(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[#e29a3e]"
          />
          <span>{t("settings.about.checkHint")}</span>
        </label>
      </div>
    </section>
  );
}
