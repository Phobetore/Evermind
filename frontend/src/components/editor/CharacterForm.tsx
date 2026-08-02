"use client";

import { Field } from "@/components/editor/Field";
import { LorebookSection } from "@/components/editor/LorebookSection";
import { TagInput } from "@/components/editor/TagInput";
import { Avatar } from "@/components/ui/Avatar";
import { useT } from "@/i18n/useT";
import { api } from "@/lib/api";
import { downloadBlob } from "@/lib/utils";
import type { Character, Connection, Kind, LoreEntry, LoreEntryDraft } from "@/types";
import { clsx } from "clsx";
import {
  BookOpenText, ChevronDown, FileDown, ImagePlus, Loader2, Plus, Sparkles, Trash2,
  UserRound, X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type Draft = Omit<Character, "id" | "avatar_url" | "is_favorite" | "created_at" | "updated_at">;

const EMPTY: Draft = {
  kind: "character",
  name: "",
  tagline: "",
  description: "",
  personality: "",
  scenario: "",
  greeting: "",
  alternate_greetings: [],
  example_dialogues: "",
  system_prompt: "",
  post_history_instructions: "",
  creator_notes: "",
  tags: [],
  creator: "",
  character_version: "",
};

const KIND_COPY: Record<Kind, Record<string, { labelKey: string; hintKey: string }>> = {
  character: {
    description: {
      labelKey: "characters.form.descriptionLabel",
      hintKey: "characters.form.descriptionHint",
    },
    personality: { labelKey: "characters.form.personalityLabel", hintKey: "characters.form.personalityHint" },
    scenario: { labelKey: "characters.form.startingSituationLabel", hintKey: "characters.form.startingSituationHint" },
    greeting: { labelKey: "characters.form.greetingLabel", hintKey: "characters.form.greetingHint" },
  },
  scenario: {
    description: {
      labelKey: "characters.form.worldLabel",
      hintKey: "characters.form.worldHint",
    },
    personality: { labelKey: "characters.form.toneLabel", hintKey: "characters.form.toneHint" },
    scenario: { labelKey: "characters.form.playerRoleLabel", hintKey: "characters.form.playerRoleHint" },
    greeting: { labelKey: "characters.form.openingSceneLabel", hintKey: "characters.form.openingSceneHint" },
  },
};

export function CharacterForm({ initial }: { initial?: Character }) {
  const router = useRouter();
  const t = useT();
  const editing = Boolean(initial);
  const [draft, setDraft] = useState<Draft>(initial ?? EMPTY);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(initial?.avatar_url ?? null);
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [generating, setGenerating] = useState(false);
  const [assistError, setAssistError] = useState<string | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [assistConnectionId, setAssistConnectionId] = useState("");
  const [loreEntries, setLoreEntries] = useState<LoreEntryDraft[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get<Connection[]>("/api/connections").then(setConnections).catch(() => {});
    if (initial) {
      api.get<LoreEntry[]>(`/api/characters/${initial.id}/lore`).then(setLoreEntries).catch(() => {});
    }
  }, [initial]);

  const copy = KIND_COPY[draft.kind];
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  async function generate() {
    if (!brief.trim() || generating) return;
    setGenerating(true);
    setAssistError(null);
    try {
      const existing: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(draft)) {
        if (typeof value === "string" && value.trim()) existing[key] = value;
        if (Array.isArray(value) && value.length > 0) existing[key] = value;
      }
      delete existing.kind;
      if (loreEntries.length > 0) existing.lore_entries = loreEntries;
      const generated = await api.post<
        Partial<Draft> & { lore_entries?: { keys: string[]; content: string }[] }
      >("/api/characters/assist", {
        prompt: brief,
        kind: draft.kind,
        existing,
        connection_id: assistConnectionId || null,
      });
      const { lore_entries: generatedLore, ...fields } = generated;
      setDraft((d) => ({ ...d, ...fields }));
      if (generatedLore?.length) {
        const additions = generatedLore.map((entry) => ({
          ...entry,
          id: crypto.randomUUID(),
          enabled: true,
          case_sensitive: false,
          priority: 0,
        }));
        // editing an existing card: the entries must be persisted right away
        const saved = initial
          ? await Promise.all(
              additions.map((entry) =>
                api.post<LoreEntry>(`/api/characters/${initial.id}/lore`, entry),
              ),
            )
          : additions;
        setLoreEntries((prev) => [...prev, ...saved]);
      }
    } catch (e) {
      setAssistError(e instanceof Error ? e.message : t("characters.assist.generateError"));
    }
    setGenerating(false);
  }

  async function save() {
    if (!draft.name.trim()) {
      setError(t("personas.nameRequired"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = editing
        ? await api.put<Character>(`/api/characters/${initial!.id}`, draft)
        : await api.post<Character>("/api/characters", draft);
      if (avatarFile) {
        await api.upload<Character>(`/api/characters/${saved.id}/avatar`, avatarFile);
      }
      if (!editing) {
        // lorebook entries drafted before the card existed
        for (const entry of loreEntries) {
          await api.post(`/api/characters/${saved.id}/lore`, {
            keys: entry.keys,
            content: entry.content,
            enabled: entry.enabled,
            case_sensitive: entry.case_sensitive,
            priority: entry.priority,
          });
        }
      }
      router.push(`/characters/${saved.id}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("personas.saveError"));
      setSaving(false);
    }
  }

  async function remove() {
    if (!initial) return;
    if (!confirm(t("characters.form.confirmDelete", { name: initial.name }))) return;
    await api.delete(`/api/characters/${initial.id}`);
    router.push("/");
    router.refresh();
  }

  async function exportCard(format: "json" | "png") {
    if (!initial) return;
    const resp = await fetch(`/api/characters/${initial.id}/export?format=${format}`);
    downloadBlob(await resp.blob(), `${initial.name}.${format}`);
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4 animate-rise">
        <h1 className="font-display text-3xl font-semibold">
          {editing ? t("characters.form.editCardTitle", { name: initial!.name }) : t("characters.form.newCardTitle")}
        </h1>
        {editing && (
          <div className="flex gap-2">
            <button className="btn btn-ghost" onClick={() => exportCard("json")}>
              <FileDown className="h-4 w-4" /> JSON
            </button>
            <button className="btn btn-ghost" onClick={() => exportCard("png")}>
              <FileDown className="h-4 w-4" /> PNG
            </button>
          </div>
        )}
      </header>

      <div className="flex flex-col gap-5">
        {/* Kind switch */}
        <div className="flex gap-2">
          {(
            [
              { value: "character", labelKey: "chat.panel.kindCharacter", icon: UserRound },
              { value: "scenario", labelKey: "chat.panel.kindScenario", icon: BookOpenText },
            ] as const
          ).map(({ value, labelKey, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => set("kind", value)}
              className={clsx(
                "flex flex-1 items-center justify-center gap-2 rounded-xl border py-3 font-display font-medium transition-colors",
                draft.kind === value
                  ? value === "scenario"
                    ? "border-arcane-500/60 bg-arcane-glow text-arcane-300"
                    : "border-ember-500/60 bg-ember-glow text-ember-300"
                  : "border-ink-700 text-mist hover:border-ink-500",
              )}
            >
              <Icon className="h-4 w-4" /> {t(labelKey)}
            </button>
          ))}
        </div>

        {/* AI assistant */}
        <div className="rounded-xl border border-ember-600/35 bg-ember-glow/40 p-4">
          <div className="mb-2 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-ember-400" />
            <span className="font-display text-sm font-semibold text-ember-300">
              {t("characters.assist.heading")}
            </span>
          </div>
          <textarea
            className="field min-h-20"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder={
              draft.kind === "scenario"
                ? t("characters.assist.briefPlaceholderScenario")
                : t("characters.assist.briefPlaceholderCharacter")
            }
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              {connections.length > 1 && (
                <select
                  className="field !w-auto max-w-52 !py-1.5 text-xs"
                  value={assistConnectionId}
                  onChange={(e) => setAssistConnectionId(e.target.value)}
                  title={t("characters.assist.connectionSelectTitle")}
                  // The control is deliberately unlabelled on screen, so a
                  // screen reader would otherwise announce it as just "combo box".
                  aria-label={t("characters.assist.connectionSelectTitle")}
                >
                  <option value="">{t("settings.defaultConnectionLabel")}</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
              <p className="text-xs text-mist-dim">
                {t("characters.assist.fieldsKeptHint")}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-primary !py-2 text-sm"
              onClick={generate}
              disabled={!brief.trim() || generating}
            >
              {generating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> {t("characters.assist.generatingButton")}
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" /> {t("characters.assist.generateButton")}
                </>
              )}
            </button>
          </div>
          {assistError && (
            <p className="mt-2 rounded-lg border border-blood/40 bg-blood/10 px-3 py-2 text-sm text-blood">
              {assistError}
            </p>
          )}
        </div>

        {/* Identity row */}
        <div className="flex gap-5">
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="group relative h-36 w-28 shrink-0 overflow-hidden rounded-xl border border-ink-600 transition-colors hover:border-ember-500"
            aria-label={t("characters.form.chooseAvatarAriaLabel")}
          >
            {avatarPreview ? (
              <Avatar name={draft.name} src={avatarPreview} rounded="rounded-none" className="h-full w-full" />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-ink-850 text-mist-dim">
                <ImagePlus className="h-6 w-6" />
                <span className="text-[0.65rem]">{t("characters.form.portraitPlaceholder")}</span>
              </div>
            )}
            <div className="absolute inset-0 hidden items-center justify-center bg-ink-950/60 group-hover:flex">
              <ImagePlus className="h-6 w-6 text-parchment" />
            </div>
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                setAvatarFile(f);
                setAvatarPreview(URL.createObjectURL(f));
              }
            }}
          />
          <div className="flex flex-1 flex-col gap-4">
            <Field label={t("personas.nameLabel")}>
              <input
                className="field"
                value={draft.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder={draft.kind === "scenario" ? t("characters.form.namePlaceholderScenario") : t("characters.form.namePlaceholderCharacter")}
              />
            </Field>
            <Field label={t("characters.form.taglineLabel")} hint={t("characters.form.taglineHint")}>
              <input
                className="field"
                value={draft.tagline}
                onChange={(e) => set("tagline", e.target.value)}
              />
            </Field>
          </div>
        </div>

        <Field label={t(copy.description.labelKey)} hint={t(copy.description.hintKey)}>
          <textarea
            className="field min-h-36"
            value={draft.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </Field>

        <div className="grid gap-5 md:grid-cols-2">
          <Field label={t(copy.personality.labelKey)} hint={t(copy.personality.hintKey)}>
            <textarea
              className="field min-h-24"
              value={draft.personality}
              onChange={(e) => set("personality", e.target.value)}
            />
          </Field>
          <Field label={t(copy.scenario.labelKey)} hint={t(copy.scenario.hintKey)}>
            <textarea
              className="field min-h-24"
              value={draft.scenario}
              onChange={(e) => set("scenario", e.target.value)}
            />
          </Field>
        </div>

        <Field label={t(copy.greeting.labelKey)} hint={t(copy.greeting.hintKey)}>
          <textarea
            className="field min-h-28"
            value={draft.greeting}
            onChange={(e) => set("greeting", e.target.value)}
          />
        </Field>

        {/* Alternate greetings */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="ui-label">{t("characters.form.alternateGreetingsLabel")}</span>
            <button
              type="button"
              className="btn btn-ghost !px-2.5 !py-1 text-xs"
              onClick={() => set("alternate_greetings", [...draft.alternate_greetings, ""])}
            >
              <Plus className="h-3.5 w-3.5" /> {t("characters.form.addGreetingButton")}
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {draft.alternate_greetings.map((greeting, i) => (
              <div key={i} className="flex gap-2">
                <textarea
                  className="field min-h-20 flex-1"
                  value={greeting}
                  onChange={(e) =>
                    set(
                      "alternate_greetings",
                      draft.alternate_greetings.map((g, j) => (j === i ? e.target.value : g)),
                    )
                  }
                />
                <button
                  type="button"
                  className="self-start rounded-lg p-2 text-mist-dim hover:bg-ink-800 hover:text-blood"
                  onClick={() =>
                    set("alternate_greetings", draft.alternate_greetings.filter((_, j) => j !== i))
                  }
                  aria-label={t("characters.form.deleteGreetingAriaLabel")}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
            {draft.alternate_greetings.length === 0 && (
              <p className="text-xs text-mist-dim">
                {t("characters.form.alternateGreetingsEmptyHint")}
              </p>
            )}
          </div>
        </div>

        <Field label={t("characters.form.tagsLabel")}>
          <TagInput value={draft.tags} onChange={(tags) => set("tags", tags)} />
        </Field>

        <Field
          label={t("characters.form.exampleDialoguesLabel")}
          hint={t("characters.form.exampleDialoguesHint")}
        >
          <textarea
            className="field min-h-28"
            value={draft.example_dialogues}
            onChange={(e) => set("example_dialogues", e.target.value)}
            placeholder={t("characters.form.exampleDialoguesPlaceholder")}
          />
        </Field>

        {/* Lorebook */}
        <LorebookSection
          characterId={initial?.id}
          entries={loreEntries}
          onChange={setLoreEntries}
        />

        {/* Advanced */}
        <button
          type="button"
          onClick={() => setAdvanced(!advanced)}
          className="flex items-center gap-2 self-start font-display text-sm font-medium text-mist transition-colors hover:text-parchment"
        >
          <ChevronDown className={clsx("h-4 w-4 transition-transform", advanced && "rotate-180")} />
          {t("characters.form.advancedSettingsToggle")}
        </button>
        {advanced && (
          <div className="flex flex-col gap-5 rounded-xl border border-ink-700 bg-ink-900/60 p-5 animate-fade">
            <Field
              label={t("characters.form.systemPromptLabel")}
              hint={t("characters.form.systemPromptHint")}
            >
              <textarea
                className="field"
                value={draft.system_prompt}
                onChange={(e) => set("system_prompt", e.target.value)}
              />
            </Field>
            <Field
              label={t("characters.form.postHistoryLabel")}
              hint={t("characters.form.postHistoryHint")}
            >
              <textarea
                className="field"
                value={draft.post_history_instructions}
                onChange={(e) => set("post_history_instructions", e.target.value)}
              />
            </Field>
            <Field label={t("characters.creatorNotesLabel")} hint={t("characters.form.creatorNotesHint")}>
              <textarea
                className="field"
                value={draft.creator_notes}
                onChange={(e) => set("creator_notes", e.target.value)}
              />
            </Field>
            <div className="grid gap-5 md:grid-cols-2">
              <Field label={t("characters.form.creatorLabel")}>
                <input
                  className="field"
                  value={draft.creator}
                  onChange={(e) => set("creator", e.target.value)}
                />
              </Field>
              <Field label={t("characters.form.versionLabel")}>
                <input
                  className="field"
                  value={draft.character_version}
                  onChange={(e) => set("character_version", e.target.value)}
                />
              </Field>
            </div>
          </div>
        )}

        {error && (
          <p className="rounded-lg border border-blood/40 bg-blood/10 px-4 py-2.5 text-sm text-blood">
            {error}
          </p>
        )}

        <div className="flex items-center justify-between border-t border-ink-700 pt-5">
          {editing ? (
            <button className="btn btn-danger" onClick={remove}>
              <Trash2 className="h-4 w-4" /> {t("common.delete")}
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button className="btn btn-ghost" onClick={() => router.back()}>
              {t("common.cancel")}
            </button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? t("characters.form.savingButton") : editing ? t("common.save") : t("characters.form.createButton")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
