"use client";

import type { Character, CharacterCreate, ExampleDialogue } from "@/types";
import { api } from "@/lib/api";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { X, Sparkles, Loader2, Plus } from "lucide-react";

interface AssistantRequest {
  name: string;
  theme: string;
  relationship: string;
  style: string;
  limits: string;
  notes: string;
}

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
  const [exampleDialogues, setExampleDialogues] = useState<ExampleDialogue[]>(
    initial?.example_dialogues ?? [],
  );

  // AI Assistant state
  const [showAssistant, setShowAssistant] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [assistantTheme, setAssistantTheme] = useState("");
  const [assistantRelationship, setAssistantRelationship] = useState("");
  const [assistantStyle, setAssistantStyle] = useState("");
  const [assistantLimits, setAssistantLimits] = useState("");
  const [assistantNotes, setAssistantNotes] = useState("");

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
        example_dialogues: exampleDialogues.filter(
          (d) => d.user.trim() || d.assistant.trim(),
        ),
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

  async function handleGenerate() {
    if (!name.trim()) {
      setError("Please enter a character name before generating.");
      return;
    }
    setGenerating(true);
    setError(null);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180_000);
    try {
      const req: AssistantRequest = {
        name,
        theme: assistantTheme,
        relationship: assistantRelationship,
        style: assistantStyle,
        limits: assistantLimits,
        notes: assistantNotes,
      };
      const result = await api.post<Record<string, unknown>>(
        "/tools/character_assistant",
        req,
        { signal: controller.signal },
      );
      // Fill form fields with generated data
      if (result.summary && typeof result.summary === "string")
        setSummary(result.summary);
      if (result.persona && typeof result.persona === "string")
        setPersona(result.persona);
      if (result.writing_style && typeof result.writing_style === "string")
        setWritingStyle(result.writing_style);
      if (result.scenario && typeof result.scenario === "string")
        setScenario(result.scenario);
      if (result.first_message && typeof result.first_message === "string")
        setFirstMessage(result.first_message);
      if (result.boundaries && typeof result.boundaries === "string")
        setBoundaries(result.boundaries);
      if (result.system_rules && typeof result.system_rules === "string")
        setSystemRules(result.system_rules);
      if (Array.isArray(result.tags))
        setTagsInput(result.tags.join(", "));
      if (Array.isArray(result.example_dialogues))
        setExampleDialogues(
          result.example_dialogues.map((d: Record<string, string>) => ({
            user: d.user ?? "",
            assistant: d.assistant ?? "",
          })),
        );
      setShowAssistant(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setError("Generation timed out — the AI server may be busy. Please try again.");
      } else {
        setError(
          err instanceof Error ? err.message : "AI generation failed",
        );
      }
    } finally {
      clearTimeout(timeoutId);
      setGenerating(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl space-y-6">
      {error && (
        <div className="rounded-lg bg-red-900/30 border border-red-800 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* AI Assistant Panel */}
      {showAssistant && (
        <div className="rounded-lg border border-indigo-800 bg-indigo-950/30 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-indigo-300 flex items-center gap-1.5">
              <Sparkles size={16} /> AI Character Assistant
            </h3>
            <button
              type="button"
              onClick={() => setShowAssistant(false)}
              className="text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <X size={16} />
            </button>
          </div>
          <p className="text-xs text-zinc-400">
            Describe what you want and the AI will fill in the character fields.
            You can edit everything afterwards.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs text-zinc-400">Theme / Setting</span>
              <input
                type="text"
                value={assistantTheme}
                onChange={(e) => setAssistantTheme(e.target.value)}
                className="input text-sm"
                placeholder="e.g. dark fantasy, sci-fi"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-zinc-400">Relationship</span>
              <input
                type="text"
                value={assistantRelationship}
                onChange={(e) => setAssistantRelationship(e.target.value)}
                className="input text-sm"
                placeholder="e.g. rival, mentor, friend"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-zinc-400">Writing Style</span>
              <input
                type="text"
                value={assistantStyle}
                onChange={(e) => setAssistantStyle(e.target.value)}
                className="input text-sm"
                placeholder="e.g. poetic, concise, dramatic"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-zinc-400">Limits / Boundaries</span>
              <input
                type="text"
                value={assistantLimits}
                onChange={(e) => setAssistantLimits(e.target.value)}
                className="input text-sm"
                placeholder="e.g. no violence, family-friendly"
              />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="text-xs text-zinc-400">Additional Notes</span>
            <textarea
              value={assistantNotes}
              onChange={(e) => setAssistantNotes(e.target.value)}
              className="input text-sm min-h-[60px]"
              placeholder="Any extra details about the character you want…"
            />
          </label>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating || !name.trim()}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
          >
            {generating ? (
              <><Loader2 size={14} className="animate-spin" /> Generating…</>
            ) : (
              <><Sparkles size={14} /> Generate with AI</>
            )}
          </button>
        </div>
      )}

      <div className="flex items-center gap-3">
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
        {!showAssistant && (
          <button
            type="button"
            onClick={() => setShowAssistant(true)}
            className="mt-6 shrink-0 flex items-center gap-1.5 rounded-lg border border-indigo-800 bg-indigo-950/30 px-3 py-2 text-xs text-indigo-300 transition-colors hover:bg-indigo-900/40"
            title="Generate character fields with AI"
          >
            <Sparkles size={14} /> AI Assist
          </button>
        )}
      </div>

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

      {/* Example Dialogues */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-zinc-300">
            Example Dialogues
          </span>
          <button
            type="button"
            onClick={() =>
              setExampleDialogues((prev) => [
                ...prev,
                { user: "", assistant: "" },
              ])
            }
            className="flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300 transition-colors"
          >
            <Plus size={12} /> Add dialogue
          </button>
        </div>
        {exampleDialogues.length === 0 && (
          <p className="text-xs text-zinc-500">
            No example dialogues. Add one to help shape the character&apos;s voice.
          </p>
        )}
        {exampleDialogues.map((dialogue, idx) => (
          <div
            key={idx}
            className="rounded-lg border border-border bg-surface/50 p-3 space-y-2"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-500">
                Example {idx + 1}
              </span>
              <button
                type="button"
                onClick={() =>
                  setExampleDialogues((prev) =>
                    prev.filter((_, i) => i !== idx),
                  )
                }
                className="text-xs text-zinc-500 hover:text-red-400 transition-colors"
                aria-label={`Remove example ${idx + 1}`}
              >
                <X size={14} />
              </button>
            </div>
            <textarea
              value={dialogue.user}
              onChange={(e) =>
                setExampleDialogues((prev) =>
                  prev.map((d, i) =>
                    i === idx ? { ...d, user: e.target.value } : d,
                  ),
                )
              }
              className="input min-h-[40px] text-sm"
              placeholder="User says…"
            />
            <textarea
              value={dialogue.assistant}
              onChange={(e) =>
                setExampleDialogues((prev) =>
                  prev.map((d, i) =>
                    i === idx ? { ...d, assistant: e.target.value } : d,
                  ),
                )
              }
              className="input min-h-[40px] text-sm"
              placeholder="Character responds…"
            />
          </div>
        ))}
      </div>

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
          className="rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
        >
          {saving ? "Saving…" : initial ? "Update" : "Create"}
        </button>
        <button
          type="button"
          onClick={() => router.push("/characters")}
          className="rounded-lg border border-border px-5 py-2.5 text-sm text-zinc-300 hover:bg-surface-light transition-colors"
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
