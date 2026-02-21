"use client";

import type { Character, CharacterCreate } from "@/types";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
  initial?: Character;
  onSubmit: (data: CharacterCreate) => Promise<void>;
}

export default function CharacterForm({ initial, onSubmit }: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(initial?.name ?? "");
  const [summary, setSummary] = useState(initial?.summary ?? "");
  const [persona, setPersona] = useState(initial?.persona ?? "");
  const [writingStyle, setWritingStyle] = useState(initial?.writing_style ?? "");
  const [scenario, setScenario] = useState(initial?.scenario ?? "");
  const [firstMessage, setFirstMessage] = useState(initial?.first_message ?? "");
  const [boundaries, setBoundaries] = useState(initial?.boundaries ?? "");
  const [systemRules, setSystemRules] = useState(initial?.system_rules ?? "");
  const [tagsInput, setTagsInput] = useState(initial?.tags?.join(", ") ?? "");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        name,
        tags: tagsInput
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        summary,
        persona,
        writing_style: writingStyle,
        scenario,
        first_message: firstMessage,
        boundaries,
        system_rules: systemRules,
      });
      router.push("/characters");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl space-y-6">
      {error && (
        <div className="rounded-lg bg-red-900/30 border border-red-800 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <Field label="Name" required>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={200}
          className="input"
          placeholder="Character name"
        />
      </Field>

      <Field label="Tags" hint="Comma-separated">
        <input
          type="text"
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          className="input"
          placeholder="e.g. fantasy, kind, elf"
        />
      </Field>

      <Field label="Summary">
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          className="input min-h-[80px]"
          placeholder="Brief character description"
        />
      </Field>

      <Field label="Persona">
        <textarea
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          className="input min-h-[120px]"
          placeholder="Personality traits, background, motivations…"
        />
      </Field>

      <Field label="Writing Style">
        <textarea
          value={writingStyle}
          onChange={(e) => setWritingStyle(e.target.value)}
          className="input min-h-[80px]"
          placeholder="Tone, vocabulary, sentence style…"
        />
      </Field>

      <Field label="Scenario">
        <textarea
          value={scenario}
          onChange={(e) => setScenario(e.target.value)}
          className="input min-h-[80px]"
          placeholder="Starting context for conversations"
        />
      </Field>

      <Field label="First Message">
        <textarea
          value={firstMessage}
          onChange={(e) => setFirstMessage(e.target.value)}
          className="input min-h-[80px]"
          placeholder="The character's opening message"
        />
      </Field>

      <Field label="Boundaries">
        <textarea
          value={boundaries}
          onChange={(e) => setBoundaries(e.target.value)}
          className="input min-h-[60px]"
          placeholder="Content limits and safety boundaries"
        />
      </Field>

      <Field label="System Rules">
        <textarea
          value={systemRules}
          onChange={(e) => setSystemRules(e.target.value)}
          className="input min-h-[60px]"
          placeholder="Character-specific rules"
        />
      </Field>

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={saving || !name.trim()}
          className="rounded-lg bg-zinc-100 px-5 py-2.5 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200 disabled:opacity-50"
        >
          {saving ? "Saving…" : initial ? "Update" : "Create"}
        </button>
        <button
          type="button"
          onClick={() => router.push("/characters")}
          className="rounded-lg border border-zinc-700 px-5 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-zinc-300">
        {label}
        {required && <span className="text-red-400 ml-1">*</span>}
      </span>
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
      {children}
    </label>
  );
}
