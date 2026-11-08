import { Field } from "@/components/editor/Field";
import { Avatar } from "@/components/ui/Avatar";
import { data, DataError } from "@/data";
import { useT } from "@/i18n/useT";
import { describeConsolidation, describeExtraction } from "@/lib/consolidation";
import { describeError, describeFailure, isUnanswered } from "@/lib/errors";
import { PATIENCE_MS } from "@/lib/useTurn";
import { previewMacros } from "@/lib/utils";
import type { Connection, Conversation, Memory, Persona } from "@/types";
import { clsx } from "clsx";
import { BrainCircuit, Image as ImageIcon, Layers, Loader2, Megaphone, Pin, Plus, SlidersHorizontal, Type, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { Link } from "react-router";

type Where = "connection" | "directive" | "summary" | "memory";

export function ChatSidePanel({
  conversation,
  persona,
  storyCuts = 0,
  takeFocus = false,
  onClose,
  onConversationChange,
  onAdjustWallpaper,
}: {
  conversation: Conversation;
  persona: Persona | null;
  /** Changes when the server takes the memory back, with a cut or a reply written over. */
  storyCuts?: number;
  /** Opened by hand: the focus starts on its close button. */
  takeFocus?: boolean;
  onClose: () => void;
  onConversationChange: (patch: Partial<Conversation>) => void;
  onAdjustWallpaper: () => void;
}) {
  const t = useT();
  const character = conversation.character!;
  const [connections, setConnections] = useState<Connection[]>([]);
  // null unless typing: the box shows what the conversation holds. `over` is what it was typed over.
  const [summaryDraft, setSummaryDraft] = useState<{ text: string; over: string } | null>(null);
  const [directiveDraft, setDirectiveDraft] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Where, string>>>({});
  const [memories, setFacts] = useState<Memory[]>([]);
  // Each read of the facts, and each change made here, outdates the reads sent before it.
  const listed = useRef(0);
  const setMemories = (change: SetStateAction<Memory[]>) => {
    listed.current++;
    setFacts(change);
  };
  const readFacts = useCallback(() => {
    const sent = ++listed.current;
    data.memories
      .list(conversation.id)
      .then((facts) => sent === listed.current && setFacts(facts))
      .catch(() => {});
  }, [conversation.id]);
  const [newFact, setNewFact] = useState("");
  const [memorizing, setMemorizing] = useState(false);
  const [memoryNote, setMemoryNote] = useState<string | null>(null);
  const [consolidating, setConsolidating] = useState(false);
  // A Remember or a Condense that got no answer, or met a pass under way, and what was said of it.
  const [unsettled, setUnsettled] = useState<{ line: string; unanswered: boolean } | null>(null);
  const summary = summaryDraft?.text ?? conversation.summary;
  const directive = directiveDraft ?? conversation.author_note ?? "";
  const wallpaperInput = useRef<HTMLInputElement>(null);
  const [wallpaperBusy, setWallpaperBusy] = useState(false);
  const [wallpaperError, setWallpaperError] = useState<string | null>(null);

  async function pickWallpaper(file: File | undefined) {
    if (!file) return;
    setWallpaperBusy(true);
    setWallpaperError(null);
    try {
      const updated = await data.conversations.setWallpaper(conversation.id, file);
      onConversationChange({
        wallpaper_url: updated.wallpaper_url,
        wallpaper_opacity: updated.wallpaper_opacity,
      });
    } catch (e) {
      setWallpaperError(describeError(e, t, t("chat.wallpaper.failed")));
    }
    setWallpaperBusy(false);
  }

  async function clearWallpaper() {
    setWallpaperBusy(true);
    try {
      await data.conversations.clearWallpaper(conversation.id);
      onConversationChange({ wallpaper_url: null });
    } catch (e) {
      setWallpaperError(describeError(e, t, t("chat.wallpaper.failed")));
    }
    setWallpaperBusy(false);
  }

  // Caught: offline it rejects, and an unhandled rejection is noise in the console.
  useEffect(() => {
    data.connections?.list().then(setConnections).catch(() => {});
  }, [conversation.id]);
  useEffect(() => {
    readFacts();
  }, [readFacts, storyCuts]);

  // Read again on opening, after a cut and on return: a pass writes the summary on its own.
  const latest = useRef({ conversation, onConversationChange });
  useEffect(() => {
    latest.current = { conversation, onConversationChange };
  });
  // A field this panel writes keeps the number of the last read sent, whose answer may be older.
  const reads = useRef(0);
  const written = useRef<Partial<Record<keyof Conversation, number>>>({});
  // The read waited for, which one sent after it, or the panel going, gives up on.
  const reading = useRef<AbortController | null>(null);
  function write(patch: Partial<Conversation>) {
    for (const key of Object.keys(patch)) written.current[key as keyof Conversation] = reads.current;
    onConversationChange(patch);
  }
  /** Its answer, or null if none came. */
  const read = useCallback(() => {
    const sent = ++reads.current;
    reading.current?.abort();
    reading.current = new AbortController();
    return data.conversations
      .get(conversation.id, { signal: reading.current.signal, within: PATIENCE_MS })
      .then((answer) => {
        if (sent !== reads.current) return answer; // a later read knows more
        const shown = latest.current.conversation;
        const patch: Partial<Conversation> = {};
        for (const key of ["summary", "author_note", "memory_error"] as const) {
          const value = answer[key] ?? null;
          if ((written.current[key] ?? 0) < sent && JSON.stringify(value) !== JSON.stringify(shown[key] ?? null))
            Object.assign(patch, { [key]: value });
        }
        // A patch re-renders the whole story, so it is made only for a change.
        if (Object.keys(patch).length) latest.current.onConversationChange(patch);
        return answer;
      })
      .catch(() => null);
  }, [conversation.id]);
  useEffect(() => {
    // A phone waking fires both events, and they make one read.
    let waking: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(waking);
      waking = setTimeout(() => {
        read();
        readFacts();
      }, 100);
    };
    read();
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearTimeout(waking);
      reading.current?.abort();
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [read, readFacts, storyCuts]);

  // Read until the server answers and runs no pass: what it holds then is shown, and what was said goes.
  useEffect(() => {
    if (!unsettled) return;
    let next: ReturnType<typeof setTimeout> | undefined;
    let gone = false;
    const unsay = () =>
      setErrors((said) => (said.memory === unsettled.line ? { ...said, memory: undefined } : said));
    const look = async () => {
      const answer = await read();
      if (gone) return;
      if (answer && unsettled.unanswered) unsay();
      if (answer && !answer.memory_running) {
        unsay();
        readFacts();
        setUnsettled(null);
      } else next = setTimeout(look, 2000);
    };
    void look();
    return () => {
      gone = true;
      clearTimeout(next);
    };
  }, [unsettled, read, readFacts]);

  // A pass of its own that failed is told here until one succeeds.
  const failed = conversation.memory_error;
  const memoryError =
    errors.memory ?? (failed ? describeFailure({ kind: failed.kind, message: failed.error }, t) : null);

  const fail = (where: Where, text: string | null) =>
    setErrors((prev) => ({ ...prev, [where]: text ?? undefined }));

  async function saveDirective() {
    if (directiveDraft === null) return;
    const value = directiveDraft.trim();
    fail("directive", null);
    if (value !== (conversation.author_note ?? "")) {
      try {
        await data.conversations.update(conversation.id, { author_note: value });
      } catch (e) {
        fail("directive", describeError(e, t));
        return;
      }
      write({ author_note: value });
    }
    setDirectiveDraft(null);
  }

  async function memorizeNow() {
    setMemorizing(true);
    setMemoryNote(null);
    setUnsettled(null);
    fail("memory", null);
    try {
      const result = await data.memories.extract(conversation.id);
      setMemories(result.memories);
      write({ memory_error: null });
      // What is being typed stays in the box, still typed over the summary from before.
      if (result.summary) write({ summary: result.summary });
      setMemoryNote(describeExtraction(result, t, conversation.summary));
      setTimeout(() => setMemoryNote(null), 4000);
    } catch (e) {
      failedMemory(e, t("chat.panel.facts.extractError"), true);
    }
    setMemorizing(false);
  }

  async function consolidateMemory() {
    setConsolidating(true);
    setMemoryNote(null);
    setUnsettled(null);
    fail("memory", null);
    try {
      const result = await data.memories.consolidate(conversation.id);
      setMemories(result.memories);
      setMemoryNote(describeConsolidation(result, t));
      setTimeout(() => setMemoryNote(null), 5000);
    } catch (e) {
      failedMemory(e, t("chat.panel.facts.consolidateError"), true);
    }
    setConsolidating(false);
  }

  async function addFact() {
    const content = newFact.trim();
    if (!content) return;
    fail("memory", null);
    try {
      const saved = await data.memories.create(conversation.id, { content, is_pinned: true });
      // The model's fact of the same words, if it had one, is theirs now.
      setMemories((prev) => [saved, ...prev.filter((m) => m.id !== saved.id)]);
      setNewFact("");
    } catch (e) {
      failedMemory(e, t("chat.panel.facts.addError"));
    }
  }

  // A pass, a merge or a cut in the story may have changed the facts meanwhile.
  function failedMemory(error: unknown, fallback?: string, aPass = false) {
    const line = describeError(error, t, fallback);
    fail("memory", line);
    readFacts();
    // One that got no answer, or met another, may change the memory yet.
    const unanswered = isUnanswered(error);
    if (aPass && (unanswered || (error instanceof DataError && error.kind === "memory_busy"))) {
      setUnsettled({ line, unanswered });
    }
  }

  async function togglePin(memory: Memory) {
    fail("memory", null);
    try {
      const updated = await data.memories.update(memory.id, { is_pinned: !memory.is_pinned });
      setMemories((prev) => prev.map((m) => (m.id === memory.id ? updated : m)));
    } catch (e) {
      failedMemory(e);
    }
  }

  async function removeFact(memory: Memory) {
    fail("memory", null);
    try {
      await data.memories.remove(memory.id);
      setMemories((prev) => prev.filter((m) => m.id !== memory.id));
    } catch (e) {
      failedMemory(e);
    }
  }

  async function changeConnection(connectionId: string) {
    fail("connection", null);
    try {
      await data.conversations.update(conversation.id, { connection_id: connectionId });
    } catch (e) {
      fail("connection", describeError(e, t));
      return;
    }
    onConversationChange({ connection_id: connectionId });
  }

  async function saveSummary() {
    fail("summary", null);
    try {
      await data.conversations.update(conversation.id, { summary, summary_was: summaryDraft?.over });
    } catch (e) {
      fail("summary", describeError(e, t));
      return;
    }
    write({ summary });
    setSummaryDraft(null);
    setNote(t("chat.panel.summary.saved"));
    setTimeout(() => setNote(null), 1500);
  }

  return (
    <aside
      // Opaque over the conversation on a phone, where blur is unreliable; a column beside it from md.
      className="fixed inset-0 z-40 flex flex-col gap-5 overflow-y-auto border-ink-700 bg-ink-900 p-5 animate-rise md:static md:w-80 md:shrink-0 md:border-l md:bg-ink-900/70 md:animate-fade"
      style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
      // Not from a box being typed in, whose words would go with the panel.
      onKeyDown={(e) => e.key === "Escape" && !(e.target as Element).matches("input, textarea") && onClose()}
    >
      <div className="flex items-start justify-between gap-2">
        {/* min-w-0 down the chain, and the name allowed to break anywhere: a name
            is whatever its owner typed, and a handle is one long word. */}
        <Link to={`/characters/${character.id}`} className="group flex min-w-0 items-center gap-3">
          <Avatar
            name={character.name}
            src={character.avatar_url}
            className="h-12 w-12 shrink-0 text-lg"
          />
          <div className="min-w-0">
            <h3 className="break-words font-display font-semibold leading-tight group-hover:text-ember-300">
              {character.name}
            </h3>
            <p className="text-xs text-mist">{character.kind === "scenario" ? t("chat.panel.kindScenario") : t("chat.panel.kindCharacter")}</p>
          </div>
        </Link>
        <button
          onClick={onClose}
          autoFocus={takeFocus}
          className="touch-target shrink-0 rounded-lg p-1.5 text-mist hover:bg-ink-700 hover:text-parchment"
          aria-label={t("chat.panel.closeAriaLabel")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {persona && (
        <div className="break-words text-sm text-mist">
          {t("chat.panel.youArePlaying")} <span className="font-display font-semibold text-parchment-dim">{persona.name}</span>
        </div>
      )}

      {data.connections && (
        <Field label={t("chat.panel.modelLabel")}>
          <select
            className="field"
            value={conversation.connection_id ?? ""}
            onChange={(e) => changeConnection(e.target.value)}
          >
            <option value="" disabled>
              {t("chat.panel.chooseModelOption")}
            </option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} {c.model ? `· ${c.model}` : ""}
              </option>
            ))}
          </select>
          {errors.connection && <p className="mt-1.5 break-words text-xs text-blood">{errors.connection}</p>}
        </Field>
      )}

      {/* What the text box understands: only what this app renders or does. */}
      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <Type className="h-3.5 w-3.5 text-arcane-300" />
          <span className="ui-label">{t("chat.writing.title")}</span>
        </div>
        <dl className="flex flex-col gap-1.5 text-xs leading-relaxed">
          {[
            ["*text*", t("chat.writing.action")],
            ["**text**", t("chat.writing.emphasis")],
            ["> text", t("chat.writing.quote")],
            ["- text", t("chat.writing.list")],
            ["`text`", t("chat.writing.code")],
          ].map(([syntax, meaning]) => (
            <div key={syntax} className="flex items-baseline gap-2">
              <dt className="shrink-0 rounded border border-ink-600 bg-ink-950/60 px-1.5 py-0.5 font-mono text-[0.7rem] text-parchment-dim">
                {syntax}
              </dt>
              <dd className="min-w-0 text-mist">{meaning}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs leading-relaxed text-mist-dim">
          {t("chat.writing.modes")}
        </p>
      </div>

      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <ImageIcon className="h-3.5 w-3.5 text-arcane-300" />
          <span className="ui-label">{t("chat.wallpaper.title")}</span>
        </div>
        <p className="mb-2 text-xs leading-relaxed text-mist-dim">
          {t("chat.wallpaper.description")}
        </p>

        {conversation.wallpaper_url ? (
          <>
            <div className="flex items-start gap-3">
              <img
                src={conversation.wallpaper_url}
                alt=""
                className="h-16 w-24 shrink-0 rounded-lg border border-ink-600 object-cover"
                draggable={false}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <button
                  type="button"
                  className="btn btn-ghost !py-1.5 text-xs"
                  onClick={() => wallpaperInput.current?.click()}
                  disabled={wallpaperBusy}
                >
                  {t("chat.wallpaper.replace")}
                </button>
                <button
                  type="button"
                  className="btn btn-danger !py-1.5 text-xs"
                  onClick={clearWallpaper}
                  disabled={wallpaperBusy}
                >
                  {t("chat.wallpaper.remove")}
                </button>
              </div>
            </div>

            <button
              type="button"
              className="btn btn-ghost mt-3 w-full !py-1.5 text-xs"
              onClick={onAdjustWallpaper}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {t("chat.wallpaper.adjust")}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-ghost w-full !py-1.5 text-xs"
            onClick={() => wallpaperInput.current?.click()}
            disabled={wallpaperBusy}
          >
            {wallpaperBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ImageIcon className="h-3.5 w-3.5" />
            )}
            {t("chat.wallpaper.choose")}
          </button>
        )}

        <input
          ref={wallpaperInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            pickWallpaper(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {wallpaperError && <p className="mt-2 break-words text-xs text-blood">{wallpaperError}</p>}
      </div>

      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <Megaphone className="h-3.5 w-3.5 text-ember-400" />
          <span className="ui-label">{t("chat.panel.directive.title")}</span>
        </div>
        <p className="mb-2 text-xs leading-relaxed text-mist-dim">
          {t("chat.panel.directive.description")}
        </p>
        <textarea
          className="field min-h-20 text-sm"
          value={directive}
          onChange={(e) => setDirectiveDraft(e.target.value)}
          onBlur={saveDirective}
          placeholder={t("chat.panel.directive.placeholder")}
        />
        {directive.trim() !== (conversation.author_note ?? "") && (
          <button className="btn btn-ghost mt-2 w-full !py-1.5 text-xs" onClick={saveDirective}>
            {t("chat.panel.directive.applyButton")}
          </button>
        )}
        {errors.directive && <p className="mt-1.5 break-words text-xs text-blood">{errors.directive}</p>}
      </div>

      <div>
        <span className="ui-label mb-1.5 block">{t("chat.panel.summary.title")}</span>
        <textarea
          className="field min-h-32 text-sm"
          value={summary}
          onChange={(e) => {
            const text = e.target.value;
            setSummaryDraft((draft) => ({ text, over: draft?.over ?? conversation.summary }));
          }}
          onFocus={() => summaryDraft === null && read()}
          placeholder={t("chat.panel.summary.placeholder")}
        />
        {summary !== conversation.summary && (
          <button className="btn btn-ghost mt-2 w-full !py-1.5 text-xs" onClick={saveSummary}>
            {t("chat.panel.summary.saveButton")}
          </button>
        )}
        {errors.summary && <p className="mt-1.5 break-words text-xs text-blood">{errors.summary}</p>}
        {note && <p className="mt-1.5 break-words text-xs text-moss">{note}</p>}
      </div>

      {/* The title gives way first (no min-w-0: that tells the row when to wrap); a button
          that still does not fit drops to its own line. */}
      <div>
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
          <span className="ui-label flex-1">{t("chat.panel.facts.title")} {memories.length > 0 && `(${memories.length})`}</span>
          <div className="flex max-w-full flex-wrap gap-1">
            <button
              className="btn btn-ghost !px-2 !py-1 text-xs"
              onClick={consolidateMemory}
              disabled={consolidating || memorizing}
              title={t("chat.panel.facts.consolidateTitle")}
            >
              {consolidating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Layers className="h-3.5 w-3.5" />
              )}
              {t("chat.panel.facts.consolidateButton")}
            </button>
            <button
              className="btn btn-ghost !px-2 !py-1 text-xs"
              onClick={memorizeNow}
              disabled={memorizing || consolidating}
              title={t("chat.panel.facts.extractTitle")}
            >
              {memorizing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <BrainCircuit className="h-3.5 w-3.5" />
              )}
              {t("chat.panel.facts.extractButton")}
            </button>
          </div>
        </div>
        <p className="mb-2 text-xs leading-relaxed text-mist-dim">
          {t("chat.panel.facts.description")}
        </p>
        <div className="flex flex-col gap-1.5">
          {memories.map((memory) => (
            <div
              key={memory.id}
              // On a touch screen the row is as tall as the thumb, so that its two small
              // controls, centred, have the room their reachable areas need.
              className="group/fact flex items-start gap-1.5 rounded-lg border border-ink-700 bg-ink-900/60 px-2.5 py-1.5 pointer-coarse:min-h-11 pointer-coarse:items-center"
            >
              <button
                onClick={() => togglePin(memory)}
                title={memory.is_pinned ? t("chat.panel.facts.unpinTitle") : t("chat.panel.facts.pinTitle")}
                className={clsx(
                  "touch-target mt-0.5 shrink-0 transition-colors pointer-coarse:mt-0",
                  memory.is_pinned ? "text-ember-400" : "text-mist-dim hover:text-parchment",
                )}
              >
                <Pin className={clsx("h-3.5 w-3.5", memory.is_pinned && "fill-current")} />
              </button>
              <span className="min-w-0 flex-1 break-words text-[0.82rem] leading-snug text-parchment-dim">
                {memory.content}
                {memory.source_position > 0 && (
                  <span className="ml-1 text-[0.68rem] text-mist-dim">{t("chat.panel.facts.turnBadge", { turn: memory.source_position })}</span>
                )}
              </span>
              <button
                onClick={() => removeFact(memory)}
                // Shown with the row on hover; where there is no hover, always.
                className="hover-actions touch-target mt-0.5 shrink-0 text-mist-dim hover:text-blood pointer-coarse:mt-0"
                aria-label={t("chat.panel.facts.forgetAriaLabel")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {memories.length === 0 && (
            <p className="text-xs italic text-mist-dim">
              {t("chat.panel.facts.empty")}
            </p>
          )}
        </div>
        <div className="mt-2 flex gap-1.5">
          <input
            className="field flex-1 !py-1.5 text-sm"
            value={newFact}
            onChange={(e) => setNewFact(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addFact()}
            placeholder={t("chat.panel.facts.addPlaceholder")}
          />
          <button
            className="btn btn-ghost !px-2.5 pointer-coarse:min-w-11"
            onClick={addFact}
            disabled={!newFact.trim()}
            aria-label={t("chat.panel.facts.addAriaLabel")}
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        {memoryError && <p className="mt-1.5 break-words text-xs text-blood">{memoryError}</p>}
        {memoryNote && <p className="mt-1.5 break-words text-xs text-moss">{memoryNote}</p>}
      </div>

      {character.scenario && (
        <div>
          <span className="ui-label mb-1.5 block">{t("chat.panel.sceneAnchor.title")}</span>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-mist">
            {previewMacros(character.scenario, character.name, persona?.name ?? t("chat.panel.sceneAnchor.youFallback"))}
          </p>
        </div>
      )}
    </aside>
  );
}
