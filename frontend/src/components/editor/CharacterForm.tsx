import { AssistProgress } from "@/components/editor/AssistProgress";
import { Field } from "@/components/editor/Field";
import { LorebookSection } from "@/components/editor/LorebookSection";
import { TagInput } from "@/components/editor/TagInput";
import { Avatar } from "@/components/ui/Avatar";
import { useConfirm } from "@/components/ui/Confirm";
import { data, DataError, type AssistField, type AssistState, type CharacterInput } from "@/data";
import { useT } from "@/i18n/useT";
import {
  clientIdFor, describeOutcome, fieldsToTake, follow, forgetJob, moveJob, outcome, rememberJob, rememberedJob,
  scopeOf,
} from "@/lib/assist";
import { cardFile } from "@/lib/cards";
import { describeError, isUnanswered } from "@/lib/errors";
import { downloadBlob, newId } from "@/lib/utils";
import type { CharacterWithLore, Connection, Kind, LoreEntry } from "@/types";
import { clsx } from "clsx";
import {
  BookOpenText, ChevronDown, FileDown, ImagePlus, Loader2, Plus, Sparkles, Trash2,
  UserRound, X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

type Draft = CharacterInput;

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

/** The name the form gives a field of the card, which the assistant's words use for it. */
function labelKey(field: AssistField, kind: Kind): string {
  switch (field) {
    case "name": return "personas.nameLabel";
    case "tagline": return "characters.form.taglineLabel";
    case "alternate_greetings": return "characters.form.alternateGreetingsLabel";
    case "example_dialogues": return "characters.form.exampleDialoguesLabel";
    case "tags": return "characters.form.tagsLabel";
    case "lore_entries": return "lorebook.title";
    default: return KIND_COPY[kind][field].labelKey;
  }
}

export function CharacterForm({ initial }: { initial?: CharacterWithLore }) {
  const navigate = useNavigate();
  const t = useT();
  const confirm = useConfirm();
  const editing = Boolean(initial);
  const scope = scopeOf(initial?.id);
  // A job this page began and has not seen the end of: the person reloaded, came back from another
  // page, or unlocked a phone. Read once, as the form opens, so that it opens as it was left.
  const [remembered] = useState(() => rememberedJob(scope));
  const [draft, setDraft] = useState<Draft>(
    initial ?? (remembered ? { ...EMPTY, kind: remembered.kind } : EMPTY),
  );
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(initial?.avatar_url ?? null);
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Apart from `error`, which is about saving or deleting: an export that fails
  // must not wipe out a save that did too, and its message belongs by the buttons.
  const [exportError, setExportError] = useState<string | null>(null);
  const [brief, setBrief] = useState(remembered?.brief ?? "");
  const [generating, setGenerating] = useState(Boolean(remembered));
  const [assistError, setAssistError] = useState<string | null>(null);
  // What the end of a job has to say when nothing failed: a card that arrived in part.
  const [assistNote, setAssistNote] = useState<string | null>(null);
  // The last state of the job, and when the page had it: the clock counts in the page between two.
  const [seen, setSeen] = useState<{ state: AssistState | null; at: number } | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [assistConnectionId, setAssistConnectionId] = useState("");
  const [loreEntries, setLoreEntries] = useState<LoreEntry[]>(initial?.lore_entries ?? []);
  const fileInput = useRef<HTMLInputElement>(null);
  // A save whose portrait fails has made the new card already.
  const created = useRef("");
  // The card a job belongs to: a card saved meanwhile is no longer "new".
  const scopeNow = useCallback(() => scopeOf(initial?.id || created.current), [initial?.id]);
  // A start whose answer was lost, which may have begun a job: asked again for the same brief, it is that job.
  const lostStart = useRef<{ clientId: string; brief: string } | null>(null);

  useEffect(() => {
    data.connections?.list().then(setConnections).catch(() => {});
  }, []);

  const watching = useRef<AbortController | null>(null);
  // The job whose end is in the form already: the two ways to learn of it must not both add its entries.
  const settled = useRef("");
  const here = useRef(false);
  const job = useRef("");
  // What the callbacks below need of the page as it is now, without being made again for it.
  const latest = useRef({ t, kind: draft.kind });
  useEffect(() => {
    latest.current = { t, kind: draft.kind };
  });
  const label = useCallback((field: AssistField) => latest.current.t(labelKey(field, latest.current.kind)), []);

  /** Puts what a job wrote in the form, once, and lets go of the job. */
  const settle = useCallback((state: AssistState) => {
    if (settled.current === state.id) return;
    settled.current = state.id;
    const ended = outcome(state);
    // What was typed while the model wrote stays: only a field still empty takes what it wrote.
    setDraft((d) => ({ ...d, ...fieldsToTake(d, ended.fields) }));
    if (ended.lore.length) {
      const additions = ended.lore.map((entry) => ({ ...entry, id: newId(), enabled: true }));
      setLoreEntries((prev) => [...prev, ...additions]);
    }
    forgetJob(scopeNow());
    setGenerating(false);
    setStopping(false);
    setWaiting(false);
    setSeen(null);
    const said = describeOutcome(ended, latest.current.t, label);
    if (state.error) setAssistError(said);
    else setAssistNote(said);
  }, [scopeNow, label]);

  /** The server does not know the job any more, or it never had it. */
  const lost = useCallback(() => {
    watching.current?.abort();
    forgetJob(scopeNow());
    setGenerating(false);
    setStopping(false);
    setWaiting(false);
    setSeen(null);
    setAssistError(latest.current.t("characters.assist.gone"));
  }, [scopeNow]);

  /** Follows a job until it ends. Leaving the form only stops the following: the job goes on, and is found again. */
  const watch = useCallback((id: string) => {
    watching.current?.abort();
    const own = new AbortController();
    watching.current = own;
    job.current = id;
    const at = Date.now();
    setGenerating(true);
    setAssistError(null);
    setAssistNote(null);
    setSeen((before) => before ?? { state: null, at });
    void follow(id, {
      signal: own.signal,
      onState: (state) => setSeen({ state, at: Date.now() }),
      onWaiting: setWaiting,
    }).then((end) => {
      if (end.kind === "aborted") return;
      if (end.kind === "ended") return settle(end.state);
      if (end.kind === "gone") return lost();
      // Not forgotten: a failure of the road says nothing of the job, which may be found on the next try.
      setGenerating(false);
      setWaiting(false);
      setSeen(null);
      const { t } = latest.current;
      setAssistError(describeError(end.error, t, t("characters.assist.generateError")));
    });
  }, [settle, lost]);

  async function stop() {
    if (!job.current || stopping) return;
    setStopping(true);
    try {
      const state = await data.characters.assist.stop(job.current);
      if (state.running) return setStopping(false);
      // Its end is told here, and the following, which may tell it too, is let go.
      watching.current?.abort();
      settle(state);
    } catch (e) {
      if (e instanceof DataError && e.kind === "not_found") return lost();
      setStopping(false);
      setAssistError(describeError(e, t, t("characters.assist.generateError")));
    }
  }

  useEffect(() => {
    here.current = true;
    const picking = remembered ? setTimeout(() => watch(remembered.id)) : undefined;
    return () => {
      here.current = false;
      clearTimeout(picking);
      watching.current?.abort();
    };
  }, [remembered, watch]);

  const copy = KIND_COPY[draft.kind];
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  async function generate() {
    if (!brief.trim() || generating) return;
    setGenerating(true);
    setAssistError(null);
    setAssistNote(null);
    setSeen({ state: null, at: Date.now() });
    const clientId = clientIdFor(lostStart.current, brief);
    try {
      const existing: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(draft)) {
        if (typeof value === "string" && value.trim()) existing[key] = value;
        if (Array.isArray(value) && value.length > 0) existing[key] = value;
      }
      delete existing.kind;
      existing.lore_entries = loreEntries.length > 0 ? loreEntries : undefined;
      const { id } = await data.characters.assist.start({
        prompt: brief,
        kind: draft.kind,
        existing,
        connection_id: assistConnectionId || null,
        client_id: clientId,
      });
      // Written down before anything else: from here the job is the server's, and a page that is
      // left or reloaded from now on finds it again.
      rememberJob(scopeNow(), { id, brief, kind: draft.kind });
      lostStart.current = null;
      if (here.current) watch(id);
    } catch (e) {
      lostStart.current = isUnanswered(e) ? { clientId, brief } : null;
      setAssistError(describeError(e, t, t("characters.assist.generateError")));
      setGenerating(false);
      setSeen(null);
    }
  }

  async function save() {
    if (!draft.name.trim()) {
      setError(t("personas.nameRequired"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const id = initial?.id || created.current;
      const card = { ...draft, lore_entries: loreEntries };
      const saved = id
        ? await data.characters.update(id, card)
        : await data.characters.create(card);
      created.current = saved.id;
      // A job begun on this card while it was not saved is the new card's now.
      if (!initial) moveJob("new", saved.id);
      if (avatarFile) {
        await data.characters.uploadAvatar(saved.id, avatarFile);
      }
      navigate(`/characters/${saved.id}`);
    } catch (e) {
      setError(describeError(e, t, t("personas.saveError")));
      setSaving(false);
    }
  }

  async function remove() {
    if (!initial) return;
    if (!(await confirm(t("characters.form.confirmDelete", { name: initial.name }), { action: t("common.delete"), danger: true }))) return;
    try {
      await data.characters.remove(initial.id);
      navigate("/");
    } catch (e) {
      setError(describeError(e, t));
    }
  }

  async function exportCard(format: "json" | "png") {
    if (!initial) return;
    setExportError(null);
    try {
      const { blob, filename } = await cardFile(initial, format);
      downloadBlob(blob, filename);
    } catch (e) {
      // Called from a click, so a rejection would reach nobody: say it here.
      setExportError(`${t("characters.form.exportError")} ${describeError(e, t)}`);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4 animate-rise">
        <h1 className="min-w-0 break-words font-display text-3xl font-semibold">
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
        {exportError && (
          <p
            role="alert"
            className="w-full rounded-lg border border-blood/40 bg-blood/10 px-4 py-2.5 text-sm text-blood"
          >
            {exportError}
          </p>
        )}
      </header>

      <div className="flex flex-col gap-5">
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
            disabled={generating}
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
                  disabled={generating}
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
          {generating && seen && (
            <AssistProgress
              state={seen.state}
              since={seen.at}
              waiting={waiting}
              stopping={stopping}
              label={label}
              onStop={stop}
            />
          )}
          {assistNote && (
            <p className="mt-2 break-words rounded-lg border border-ember-600/35 bg-ink-900/50 px-3 py-2 text-sm text-parchment">
              {assistNote}
            </p>
          )}
          {assistError && (
            <p className="mt-2 break-words rounded-lg border border-blood/40 bg-blood/10 px-3 py-2 text-sm text-blood">
              {assistError}
            </p>
          )}
        </div>

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

        <LorebookSection entries={loreEntries} onChange={setLoreEntries} />

        <button
          type="button"
          onClick={() => setAdvanced(!advanced)}
          className="touch-target flex items-center gap-2 self-start font-display text-sm font-medium text-mist transition-colors hover:text-parchment"
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

        {/* Wrapping: three buttons in German or French are wider than a phone. */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-700 pt-5">
          {editing ? (
            <button className="btn btn-danger" onClick={remove}>
              <Trash2 className="h-4 w-4" /> {t("common.delete")}
            </button>
          ) : (
            <span />
          )}
          <div className="ml-auto flex flex-wrap justify-end gap-2">
            <button className="btn btn-ghost" onClick={() => navigate(-1)}>
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
