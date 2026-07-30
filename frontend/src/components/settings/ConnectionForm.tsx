"use client";

import { Field } from "@/components/editor/Field";
import { Modal } from "@/components/ui/Modal";
import { useT } from "@/i18n/useT";
import { api } from "@/lib/api";
import type { Connection, ProviderType } from "@/types";
import { clsx } from "clsx";
import { CheckCircle2, ChevronDown, Loader2, Trash2, XCircle } from "lucide-react";
import { useState } from "react";

interface Preset {
  label: string;
  provider: ProviderType;
  base_url: string;
  hintKey?: string;
}

const PRESETS: Preset[] = [
  { label: "Ollama", provider: "openai-compatible", base_url: "http://localhost:11434/v1", hintKey: "connections.presetHintLocal" },
  { label: "LM Studio", provider: "openai-compatible", base_url: "http://localhost:1234/v1", hintKey: "connections.presetHintLocal" },
  { label: "llama.cpp", provider: "openai-compatible", base_url: "http://localhost:8080/v1", hintKey: "connections.presetHintLocal" },
  { label: "KoboldCpp", provider: "openai-compatible", base_url: "http://localhost:5001/v1", hintKey: "connections.presetHintLocal" },
  { label: "OpenRouter", provider: "openai-compatible", base_url: "https://openrouter.ai/api/v1", hintKey: "connections.presetHintOpenRouter" },
  { label: "OpenAI", provider: "openai-compatible", base_url: "https://api.openai.com/v1" },
  { label: "Anthropic", provider: "anthropic", base_url: "https://api.anthropic.com" },
  { label: "Groq", provider: "openai-compatible", base_url: "https://api.groq.com/openai/v1" },
  { label: "Mistral", provider: "openai-compatible", base_url: "https://api.mistral.ai/v1" },
];

interface DraftConnection {
  name: string;
  provider: ProviderType;
  base_url: string;
  api_key: string;
  model: string;
  context_size: number;
  max_tokens: number;
  temperature: number;
  top_p: number;
  frequency_penalty: number;
  presence_penalty: number;
  is_default: boolean;
}

export function ConnectionForm({
  connection,
  onClose,
  onSaved,
}: {
  connection: Connection | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<DraftConnection>({
    name: connection?.name ?? "",
    provider: connection?.provider ?? "openai-compatible",
    base_url: connection?.base_url ?? "",
    api_key: "",
    model: connection?.model ?? "",
    context_size: connection?.context_size ?? 16384,
    max_tokens: connection?.max_tokens ?? 1024,
    temperature: connection?.temperature ?? 0.8,
    top_p: connection?.top_p ?? 0.95,
    frequency_penalty: connection?.frequency_penalty ?? 0.15,
    presence_penalty: connection?.presence_penalty ?? 0.15,
    is_default: connection?.is_default ?? false,
  });
  const [advanced, setAdvanced] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string; models_sample?: string[] } | null>(null);
  const [benchmarking, setBenchmarking] = useState(false);
  const [benchResult, setBenchResult] = useState<{
    ok: boolean; detail?: string; tokens_per_s?: number; first_token_seconds?: number;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof DraftConnection>(key: K, value: DraftConnection[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setTestResult(null);
  };

  function buildPayload(includeEmptyKey = false) {
    const payload: Record<string, unknown> = { ...draft };
    if (!draft.api_key && !includeEmptyKey) delete payload.api_key;
    return payload;
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      let result;
      if (connection && !draft.api_key) {
        // saved key lives server-side only: persist edits, then test by id
        await api.put(`/api/connections/${connection.id}`, buildPayload());
        result = await api.post<typeof testResult>(`/api/connections/${connection.id}/test`);
      } else {
        result = await api.post<typeof testResult>("/api/connections/test", {
          ...draft,
          name: draft.name || "test",
        });
      }
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, detail: e instanceof Error ? e.message : t("connections.testFailed") });
    }
    setTesting(false);
  }

  async function benchmark() {
    if (!connection) return;
    setBenchmarking(true);
    setBenchResult(null);
    try {
      setBenchResult(await api.post<typeof benchResult>(`/api/connections/${connection.id}/benchmark`));
    } catch (e) {
      setBenchResult({ ok: false, detail: e instanceof Error ? e.message : t("connections.benchmarkFailed") });
    }
    setBenchmarking(false);
  }

  async function save() {
    if (!draft.name.trim() || !draft.base_url.trim()) {
      setError(t("connections.nameUrlRequired"));
      return;
    }
    setSaving(true);
    try {
      if (connection) await api.put(`/api/connections/${connection.id}`, buildPayload());
      else await api.post("/api/connections", { ...draft });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("connections.saveFailed"));
      setSaving(false);
    }
  }

  async function remove() {
    if (!connection) return;
    if (!confirm(t("connections.confirmDelete", { name: connection.name }))) return;
    await api.delete(`/api/connections/${connection.id}`);
    onSaved();
  }

  return (
    <Modal
      title={
        connection
          ? t("connections.editConnectionTitle", { name: connection.name })
          : t("connections.newConnectionTitle")
      }
      onClose={onClose}
      wide
    >
      <div className="flex flex-col gap-4">
        {!connection && (
          <div>
            <span className="ui-label mb-2 block">{t("connections.quickStartLabel")}</span>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  title={preset.hintKey ? t(preset.hintKey) : undefined}
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      name: preset.label,
                      provider: preset.provider,
                      base_url: preset.base_url,
                    }))
                  }
                  className={clsx(
                    "rounded-full border px-3.5 py-1.5 font-display text-xs font-medium transition-colors",
                    draft.base_url === preset.base_url
                      ? "border-ember-500 bg-ember-glow text-ember-300"
                      : "border-ink-600 text-mist hover:border-ink-500 hover:text-parchment",
                  )}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("connections.nameLabel")}>
            <input className="field" value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder={t("connections.namePlaceholder")} />
          </Field>
          <Field label={t("connections.providerTypeLabel")}>
            <select
              className="field"
              value={draft.provider}
              onChange={(e) => set("provider", e.target.value as ProviderType)}
            >
              <option value="openai-compatible">OpenAI-compatible (Ollama, LM Studio…)</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </Field>
        </div>

        <Field
          label={t("connections.baseUrlLabel")}
          hint={draft.provider === "anthropic" ? t("connections.baseUrlHintAnthropic") : t("connections.baseUrlHintOpenAICompatible")}
        >
          <input className="field" value={draft.base_url} onChange={(e) => set("base_url", e.target.value)} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t("connections.apiKeyLabel")}
            hint={
              connection?.api_key_set
                ? t("connections.apiKeySetHint", { hint: connection.api_key_hint })
                : t("connections.apiKeyEmptyHint")
            }
          >
            <input
              type="password"
              className="field"
              value={draft.api_key}
              onChange={(e) => set("api_key", e.target.value)}
              placeholder={connection?.api_key_set ? "••••••••" : ""}
              autoComplete="off"
            />
          </Field>
          <Field label={t("connections.modelLabel")}>
            <input
              className="field"
              value={draft.model}
              onChange={(e) => set("model", e.target.value)}
              placeholder="llama3, claude-sonnet-5…"
              list="models-found"
            />
            {testResult?.models_sample && (
              <datalist id="models-found">
                {testResult.models_sample.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            )}
          </Field>
        </div>

        {/* Test row */}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-ghost" onClick={test} disabled={testing}>
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : t("connections.testButton")}
          </button>
          {connection && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={benchmark}
              disabled={benchmarking}
              title={t("connections.benchmarkHint")}
            >
              {benchmarking ? <Loader2 className="h-4 w-4 animate-spin" /> : t("connections.benchmarkButton")}
            </button>
          )}
          {benchResult && (
            <span className={clsx("text-sm", benchResult.ok ? "text-moss" : "text-blood")}>
              {benchResult.ok
                ? t("connections.benchmarkResult", {
                    tokensPerSecond: benchResult.tokens_per_s ?? 0,
                    firstTokenSeconds: benchResult.first_token_seconds ?? 0,
                  })
                : benchResult.detail}
            </span>
          )}
          {testResult && (
            <span
              className={clsx(
                "flex items-center gap-1.5 text-sm",
                testResult.ok ? "text-moss" : "text-blood",
              )}
            >
              {testResult.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
              {testResult.detail}
            </span>
          )}
        </div>
        {testResult?.models_sample && testResult.models_sample.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {testResult.models_sample.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setDraft((d) => ({ ...d, model: m }))}
                className={clsx(
                  "rounded-full border px-2.5 py-1 font-mono text-[0.7rem] transition-colors",
                  draft.model === m
                    ? "border-ember-500 bg-ember-glow text-ember-300"
                    : "border-ink-600 text-mist hover:text-parchment",
                )}
              >
                {m}
              </button>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => setAdvanced(!advanced)}
          className="flex items-center gap-2 self-start font-display text-sm font-medium text-mist hover:text-parchment"
        >
          <ChevronDown className={clsx("h-4 w-4 transition-transform", advanced && "rotate-180")} />
          {t("connections.advancedSettingsToggle")}
        </button>
        {advanced && (
          <div className="grid gap-4 rounded-xl border border-ink-700 bg-ink-900/60 p-4 sm:grid-cols-3 animate-fade">
            <Field
              label={t("connections.contextSizeLabel")}
              hint={t("connections.contextSizeHint")}
            >
              <input type="number" className="field" value={draft.context_size} onChange={(e) => set("context_size", Number(e.target.value))} />
            </Field>
            <Field label={t("connections.maxTokensLabel")} hint={t("connections.maxTokensHint")}>
              <input type="number" className="field" value={draft.max_tokens} onChange={(e) => set("max_tokens", Number(e.target.value))} />
            </Field>
            <Field label={t("connections.temperatureLabel")} hint={t("connections.temperatureHint")}>
              <input type="number" step="0.05" className="field" value={draft.temperature} onChange={(e) => set("temperature", Number(e.target.value))} />
            </Field>
            <Field label={t("connections.topPLabel")}>
              <input type="number" step="0.01" className="field" value={draft.top_p} onChange={(e) => set("top_p", Number(e.target.value))} />
            </Field>
            <Field label={t("connections.frequencyPenaltyLabel")}>
              <input type="number" step="0.05" className="field" value={draft.frequency_penalty} onChange={(e) => set("frequency_penalty", Number(e.target.value))} />
            </Field>
            <Field label={t("connections.presencePenaltyLabel")}>
              <input type="number" step="0.05" className="field" value={draft.presence_penalty} onChange={(e) => set("presence_penalty", Number(e.target.value))} />
            </Field>
          </div>
        )}

        <label className="flex cursor-pointer items-center gap-2.5 text-sm text-parchment-dim">
          <input
            type="checkbox"
            checked={draft.is_default}
            onChange={(e) => set("is_default", e.target.checked)}
            className="h-4 w-4 accent-[#e29a3e]"
          />
          {t("connections.isDefaultLabel")}
        </label>

        {error && (
          <p className="rounded-lg border border-blood/40 bg-blood/10 px-4 py-2.5 text-sm text-blood">{error}</p>
        )}

        <div className="flex items-center justify-between border-t border-ink-700 pt-4">
          {connection ? (
            <button className="btn btn-danger" onClick={remove}>
              <Trash2 className="h-4 w-4" /> {t("common.delete")}
            </button>
          ) : (
            <span />
          )}
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? "…" : t("common.save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
