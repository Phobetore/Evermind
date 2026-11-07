import { Field } from "@/components/editor/Field";
import { Modal } from "@/components/ui/Modal";
import type { BenchmarkResult, ConnectionInput, ConnectionTestResult, DataSource } from "@/data";
import { useT } from "@/i18n/useT";
import { describeError, describeResult } from "@/lib/errors";
import type { Connection, ProviderType } from "@/types";
import { clsx } from "clsx";
import { CheckCircle2, ChevronDown, Loader2, Trash2, XCircle } from "lucide-react";
import { useState } from "react";

type Generation = Pick<
  ConnectionInput,
  "context_size" | "max_tokens" | "temperature" | "top_p" | "frequency_penalty" | "presence_penalty"
>;

/** What a new connection holds: roleplay on a local model. */
const ROLEPLAY: Generation = {
  context_size: 16384,
  max_tokens: 1024,
  temperature: 0.8,
  top_p: 0.95,
  frequency_penalty: 0.15,
  presence_penalty: 0.15,
};

/** Empty is not sent: the newest models refuse the settings they do not let a client set. */
const LEFT_TO_THE_MODEL: Generation = {
  context_size: 16384,
  max_tokens: null,
  temperature: null,
  top_p: null,
  frequency_penalty: null,
  presence_penalty: null,
};

interface Preset {
  label: string;
  provider: ProviderType;
  base_url: string;
  hintKey?: string;
  generation?: Generation;
}

const PRESETS: Preset[] = [
  { label: "Ollama", provider: "openai-compatible", base_url: "http://localhost:11434/v1", hintKey: "connections.presetHintLocal" },
  { label: "LM Studio", provider: "openai-compatible", base_url: "http://localhost:1234/v1", hintKey: "connections.presetHintLocal" },
  { label: "llama.cpp", provider: "openai-compatible", base_url: "http://localhost:8080/v1", hintKey: "connections.presetHintLocal" },
  { label: "KoboldCpp", provider: "openai-compatible", base_url: "http://localhost:5001/v1", hintKey: "connections.presetHintLocal" },
  { label: "OpenRouter", provider: "openai-compatible", base_url: "https://openrouter.ai/api/v1", hintKey: "connections.presetHintOpenRouter" },
  { label: "OpenAI", provider: "openai-compatible", base_url: "https://api.openai.com/v1", generation: LEFT_TO_THE_MODEL },
  // Its ceiling is required and counts the model's thinking: the story keeps the room it has elsewhere.
  { label: "Anthropic", provider: "anthropic", base_url: "https://api.anthropic.com", generation: { ...LEFT_TO_THE_MODEL, max_tokens: 4096, context_size: 16384 + 4096 - 1024 } },
  { label: "Groq", provider: "openai-compatible", base_url: "https://api.groq.com/openai/v1" },
  { label: "Mistral", provider: "openai-compatible", base_url: "https://api.mistral.ai/v1" },
];

const generationOf = ({ context_size, max_tokens, temperature, top_p, frequency_penalty, presence_penalty }: Connection): Generation =>
  ({ context_size, max_tokens, temperature, top_p, frequency_penalty, presence_penalty });

/** A box left empty is null. */
const numberOrNull = (value: string) => (value === "" ? null : Number(value));

/** The form always holds a key, empty when nothing was typed. */
type DraftConnection = ConnectionInput & { api_key: string };

export function ConnectionForm({
  source,
  connection,
  onClose,
  onSaved,
}: {
  /** Taken as a prop, not read from `data`, because an edition without
   *  connections has no such thing and never renders this form. */
  source: NonNullable<DataSource["connections"]>;
  connection: Connection | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const modelDefault = t("connections.modelDefaultPlaceholder");
  const [draft, setDraft] = useState<DraftConnection>({
    name: connection?.name ?? "",
    provider: connection?.provider ?? "openai-compatible",
    base_url: connection?.base_url ?? "",
    api_key: "",
    model: connection?.model ?? "",
    ...(connection ? generationOf(connection) : ROLEPLAY),
    is_default: connection?.is_default ?? false,
  });
  const [advanced, setAdvanced] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [benchmarking, setBenchmarking] = useState(false);
  const [benchResult, setBenchResult] = useState<BenchmarkResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof DraftConnection>(key: K, value: DraftConnection[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setTestResult(null);
  };

  function buildPayload(): ConnectionInput {
    const { api_key, ...rest } = draft;
    return api_key ? { ...rest, api_key } : rest;
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      let result;
      if (connection && !draft.api_key) {
        // saved key lives server-side only: persist edits, then test by id
        await source.update(connection.id, buildPayload());
        result = await source.testSaved(connection.id);
      } else {
        result = await source.test({ ...draft, name: draft.name || "test" });
      }
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, detail: describeError(e, t, t("connections.testFailed")) });
    }
    setTesting(false);
  }

  async function benchmark() {
    if (!connection) return;
    setBenchmarking(true);
    setBenchResult(null);
    try {
      setBenchResult(await source.benchmark(connection.id));
    } catch (e) {
      setBenchResult({ ok: false, detail: describeError(e, t, t("connections.benchmarkFailed")) });
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
      if (connection) await source.update(connection.id, buildPayload());
      else await source.create({ ...draft });
      onSaved();
    } catch (e) {
      setError(describeError(e, t, t("connections.saveFailed")));
      setSaving(false);
    }
  }

  async function remove() {
    if (!connection) return;
    if (!confirm(t("connections.confirmDelete", { name: connection.name }))) return;
    try {
      await source.remove(connection.id);
      onSaved();
    } catch (e) {
      setError(describeError(e, t));
    }
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
                      ...(preset.generation ?? ROLEPLAY),
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
                : describeResult(benchResult, t)}
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
              {testResult.ok && testResult.model_count !== undefined
                ? t("connections.modelsFound", { count: testResult.model_count })
                : describeResult(testResult, t)}
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
              <input type="number" className="field" placeholder={modelDefault} value={draft.max_tokens ?? ""} onChange={(e) => set("max_tokens", numberOrNull(e.target.value))} />
            </Field>
            <Field label={t("connections.temperatureLabel")} hint={t("connections.temperatureHint")}>
              <input type="number" step="0.05" className="field" placeholder={modelDefault} value={draft.temperature ?? ""} onChange={(e) => set("temperature", numberOrNull(e.target.value))} />
            </Field>
            <Field label={t("connections.topPLabel")}>
              <input type="number" step="0.01" className="field" placeholder={modelDefault} value={draft.top_p ?? ""} onChange={(e) => set("top_p", numberOrNull(e.target.value))} />
            </Field>
            <Field label={t("connections.frequencyPenaltyLabel")}>
              <input type="number" step="0.05" className="field" placeholder={modelDefault} value={draft.frequency_penalty ?? ""} onChange={(e) => set("frequency_penalty", numberOrNull(e.target.value))} />
            </Field>
            <Field label={t("connections.presencePenaltyLabel")}>
              <input type="number" step="0.05" className="field" placeholder={modelDefault} value={draft.presence_penalty ?? ""} onChange={(e) => set("presence_penalty", numberOrNull(e.target.value))} />
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
