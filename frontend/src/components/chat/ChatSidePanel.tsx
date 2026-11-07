import { Field } from "@/components/editor/Field";
import { Avatar } from "@/components/ui/Avatar";
import { data } from "@/data";
import { useT } from "@/i18n/useT";
import { describeConsolidation, describeExtraction } from "@/lib/consolidation";
import { describeError, describeResult } from "@/lib/errors";
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
  onClose,
  onConversationChange,
  onWallpaperOpacity,
  onAdjustWallpaper,
  className,
}: {
  conversation: Conversation;
  persona: Persona | null;
  /** Changes when the story is cut back, which takes facts with it. */
  storyCuts?: number;
  onClose: () => void;
  onConversationChange: (patch: Partial<Conversation>) => void;
  onWallpaperOpacity: (value: number) => void;
  onAdjustWallpaper: () => void;
  className?: string;
}) {
  const t = useT();
  const character = conversation.character!;
  const [connections, setConnections] = useState<Connection[]>([]);
  // null unless typing: the box shows what the conversation holds.
  const [summaryDraft, setSummaryDraft] = useState<string | null>(null);
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
  const summary = summaryDraft ?? conversation.summary;
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

  // Caught: offline, these reject, and an unhandled rejection is noise in a
  // console that a real fault has to be found in.
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
  const aside = useRef<HTMLElement>(null);
  // A field this panel writes keeps the number of the last read sent, whose answer may be older.
  const reads = useRef(0);
  const written = useRef<Partial<Record<keyof Conversation, number>>>({});
  function write(patch: Partial<Conversation>) {
    for (const key of Object.keys(patch)) written.current[key as keyof Conversation] = reads.current;
    onConversationChange(patch);
  }
  const read = useCallback((evenHidden = false) => {
    // Hidden (the inline panel on a phone), it reads only after a cut: nothing else brings that.
    if (!evenHidden && !aside.current?.offsetParent) return;
    const sent = ++reads.current;
    data.conversations
      .get(conversation.id)
      .then((answer) => {
        if (sent !== reads.current) return; // a later read knows more
        const shown = latest.current.conversation;
        const patch: Partial<Conversation> = {};
        for (const key of ["summary", "author_note", "memory_error"] as const) {
          const value = answer[key] ?? null;
          if ((written.current[key] ?? 0) < sent && JSON.stringify(value) !== JSON.stringify(shown[key] ?? null))
            Object.assign(patch, { [key]: value });
        }
        // A patch re-renders the whole story, so it is made only for a change.
        if (Object.keys(patch).length) latest.current.onConversationChange(patch);
      })
      .catch(() => {});
  }, [conversation.id]);
  useEffect(() => {
    // A phone waking fires both events, and they make one read.
    let waking: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(waking);
      waking = setTimeout(() => read(), 100);
    };
    read(storyCuts > 0);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearTimeout(waking);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [read, storyCuts]);

  // A pass of its own that failed is told here until one succeeds.
  const failed = conversation.memory_error;
  const memoryError =
    errors.memory ??
    (failed
      ? describeResult(
          {
            detail: failed.error,
            kind: failed.kind,
            upstream: failed.upstream,
            upstream_status: failed.upstream_status,
            upstream_url: failed.upstream_url,
          },
          t,
        )
      : null);

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
    fail("memory", null);
    try {
      const result = await data.memories.extract(conversation.id);
      setMemories(result.memories);
      write({ memory_error: null });
      if (result.summary) {
        write({ summary: result.summary });
        setSummaryDraft(null);
      }
      setMemoryNote(describeExtraction(result, t, conversation.summary));
      setTimeout(() => setMemoryNote(null), 4000);
    } catch (e) {
      failedMemory(e, t("chat.panel.facts.extractError"));
    }
    setMemorizing(false);
  }

  async function consolidateMemory() {
    setConsolidating(true);
    setMemoryNote(null);
    fail("memory", null);
    try {
      const result = await data.memories.consolidate(conversation.id);
      setMemories(result.memories);
      setMemoryNote(describeConsolidation(result, t));
      setTimeout(() => setMemoryNote(null), 5000);
    } catch (e) {
      failedMemory(e, t("chat.panel.facts.consolidateError"));
    }
    setConsolidating(false);
  }

  async function addFact() {
    const content = newFact.trim();
    if (!content) return;
    fail("memory", null);
    try {
      const saved = await data.memories.create(conversation.id, { content, is_pinned: true });
      setMemories((prev) => [saved, ...prev]);
      setNewFact("");
    } catch (e) {
      failedMemory(e, t("chat.panel.facts.addError"));
    }
  }

  // A pass, a merge or a cut in the story may have changed the facts meanwhile.
  function failedMemory(error: unknown, fallback?: string) {
    fail("memory", describeError(error, t, fallback));
    readFacts();
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

  // What is typed while the memory writes a summary would be replaced by what it writes.
  const summaryIsBeingWritten = memorizing;

  async function saveSummary() {
    fail("summary", null);
    try {
      await data.conversations.update(conversation.id, { summary });
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
      ref={aside}
      className={clsx(
        // No translucency here: as a mobile overlay this sits on top of the
        // conversation, and blur support is unreliable on phones.
        "flex shrink-0 flex-col gap-5 overflow-y-auto border-ink-700 bg-ink-900 p-5 animate-fade md:bg-ink-900/70",
        className ?? "w-80 border-l",
      )}
      style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
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

      {/* What the text box actually understands. Everything listed is something
          this app renders or does — nothing aspirational, and nothing carried
          over from another tool's conventions. */}
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

      {/* Backdrop. The opacity slider sits here on a wide screen, where the
          conversation is beside the panel and the change can be seen as it is
          made. On a phone the panel covers the conversation, so the button
          hands the job over to a bar that sits on top of the real thing. */}
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

            <div className="mt-3 hidden md:block">
              <div className="mb-1 flex items-center justify-between text-xs text-mist">
                <span>{t("chat.wallpaper.opacity")}</span>
                <span className="tabular-nums text-parchment-dim">
                  {Math.round((conversation.wallpaper_opacity ?? 0.25) * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round((conversation.wallpaper_opacity ?? 0.25) * 100)}
                onChange={(e) => onWallpaperOpacity(Number(e.target.value) / 100)}
                className="w-full accent-[#e29a3e]"
                aria-label={t("chat.wallpaper.opacity")}
              />
            </div>

            <button
              type="button"
              className="btn btn-ghost mt-3 w-full !py-1.5 text-xs md:hidden"
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

      {/* Scene directive: reaches the model at the most influential position
          (right before generation), so it holds even on long chats. */}
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
          onChange={(e) => setSummaryDraft(e.target.value)}
          onFocus={() => summaryDraft === null && read()}
          disabled={summaryIsBeingWritten}
          placeholder={t("chat.panel.summary.placeholder")}
        />
        {summary !== conversation.summary && (
          <button
            className="btn btn-ghost mt-2 w-full !py-1.5 text-xs"
            onClick={saveSummary}
            disabled={summaryIsBeingWritten}
          >
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
