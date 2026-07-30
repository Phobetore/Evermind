"use client";

import { Field } from "@/components/editor/Field";
import { Avatar } from "@/components/ui/Avatar";
import { useT } from "@/i18n/useT";
import { api } from "@/lib/api";
import { previewMacros } from "@/lib/utils";
import type { Connection, Conversation, Memory, Persona } from "@/types";
import { clsx } from "clsx";
import { BrainCircuit, Layers, Loader2, Megaphone, NotebookPen, Pin, Plus, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

// Mirrors the backend's select_facts: which facts actually reach the model,
// so the panel can dim the dormant ones instead of hiding the limit.
function computeDormant(memories: Memory[], contextSize: number, maxTokens: number): Set<string> {
  const est = (s: string) => Math.floor(s.length / 3.5) + 1;
  const ctxBudget = Math.max(512, contextSize - maxTokens - 200);
  let budget = Math.min(2000, Math.max(700, Math.floor(ctxBudget * 0.12)));
  const pinned = memories.filter((m) => m.is_pinned);
  const others = memories
    .filter((m) => !m.is_pinned)
    .sort((a, b) => b.source_position - a.source_position);
  const active = new Set<string>();
  for (const m of [...pinned, ...others]) {
    if (active.size >= 60) break;
    const cost = est(m.content);
    if (!m.is_pinned && cost > budget) continue;
    budget -= cost;
    active.add(m.id);
  }
  return new Set(memories.filter((m) => !active.has(m.id)).map((m) => m.id));
}

export function ChatSidePanel({
  conversation,
  persona,
  onClose,
  onConversationChange,
  className,
}: {
  conversation: Conversation;
  persona: Persona | null;
  onClose: () => void;
  onConversationChange: (patch: Partial<Conversation>) => void;
  className?: string;
}) {
  const t = useT();
  const character = conversation.character!;
  const [connections, setConnections] = useState<Connection[]>([]);
  const [summary, setSummary] = useState(conversation.summary);
  const [summarizing, setSummarizing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [newFact, setNewFact] = useState("");
  const [memorizing, setMemorizing] = useState(false);
  const [memoryNote, setMemoryNote] = useState<string | null>(null);
  const [consolidating, setConsolidating] = useState(false);
  const [directive, setDirective] = useState(conversation.author_note ?? "");

  useEffect(() => {
    api.get<Connection[]>("/api/connections").then(setConnections);
    api.get<Memory[]>(`/api/conversations/${conversation.id}/memories`).then(setMemories);
  }, [conversation.id]);
  useEffect(() => setSummary(conversation.summary), [conversation.summary]);
  useEffect(() => setDirective(conversation.author_note ?? ""), [conversation.author_note]);

  async function saveDirective() {
    const value = directive.trim();
    if (value === (conversation.author_note ?? "")) return;
    await api.patch(`/api/conversations/${conversation.id}`, { author_note: value });
    onConversationChange({ author_note: value });
  }

  async function memorizeNow() {
    setMemorizing(true);
    setMemoryNote(null);
    try {
      const result = await api.post<{
        facts_added: Memory[]; summary: string | null; memories: Memory[];
      }>(`/api/conversations/${conversation.id}/memories/extract`);
      setMemories(result.memories);
      if (result.summary) {
        setSummary(result.summary);
        onConversationChange({ summary: result.summary });
      }
      setMemoryNote(
        result.facts_added.length > 0
          ? t("chat.panel.facts.addedCount", { count: result.facts_added.length })
          : t("chat.panel.facts.noneNew"),
      );
    } catch (e) {
      setMemoryNote(e instanceof Error ? e.message : t("chat.panel.facts.extractError"));
    }
    setMemorizing(false);
    setTimeout(() => setMemoryNote(null), 4000);
  }

  async function consolidateMemory() {
    setConsolidating(true);
    setMemoryNote(null);
    try {
      const result = await api.post<{ before: number; after: number; memories: Memory[]; skipped?: string }>(
        `/api/conversations/${conversation.id}/memories/consolidate`,
      );
      setMemories(result.memories);
      setMemoryNote(
        result.skipped
          ? t("chat.panel.facts.tooFewToConsolidate")
          : t("chat.panel.facts.consolidated", { before: result.before, after: result.after }),
      );
    } catch (e) {
      setMemoryNote(e instanceof Error ? e.message : t("chat.panel.facts.consolidateError"));
    }
    setConsolidating(false);
    setTimeout(() => setMemoryNote(null), 5000);
  }

  async function addFact() {
    const content = newFact.trim();
    if (!content) return;
    try {
      const saved = await api.post<Memory>(`/api/conversations/${conversation.id}/memories`, {
        content, is_pinned: true,
      });
      setMemories((prev) => [saved, ...prev]);
      setNewFact("");
    } catch (e) {
      setMemoryNote(e instanceof Error ? e.message : t("chat.panel.facts.addError"));
      setTimeout(() => setMemoryNote(null), 3000);
    }
  }

  async function togglePin(memory: Memory) {
    const updated = await api.patch<Memory>(`/api/memories/${memory.id}`, {
      is_pinned: !memory.is_pinned,
    });
    setMemories((prev) => prev.map((m) => (m.id === memory.id ? updated : m)));
  }

  async function removeFact(memory: Memory) {
    await api.delete(`/api/memories/${memory.id}`);
    setMemories((prev) => prev.filter((m) => m.id !== memory.id));
  }

  const activeConn = connections.find((c) => c.id === conversation.connection_id);
  const dormant = useMemo(
    () => computeDormant(memories, activeConn?.context_size ?? 16384, activeConn?.max_tokens ?? 1024),
    [memories, activeConn?.context_size, activeConn?.max_tokens],
  );

  async function changeConnection(connectionId: string) {
    await api.patch(`/api/conversations/${conversation.id}`, { connection_id: connectionId });
    onConversationChange({ connection_id: connectionId });
  }

  async function saveSummary() {
    await api.patch(`/api/conversations/${conversation.id}`, { summary });
    onConversationChange({ summary });
    setNote(t("chat.panel.summary.saved"));
    setTimeout(() => setNote(null), 1500);
  }

  async function generateSummary() {
    setSummarizing(true);
    setNote(null);
    try {
      const updated = await api.post<Conversation>(
        `/api/conversations/${conversation.id}/summarize`,
      );
      setSummary(updated.summary);
      onConversationChange({ summary: updated.summary });
      setNote(t("chat.panel.summary.generated"));
    } catch (e) {
      setNote(e instanceof Error ? e.message : t("chat.panel.summary.generateError"));
    }
    setSummarizing(false);
    setTimeout(() => setNote(null), 4000);
  }

  return (
    <aside
      className={clsx(
        // No translucency here: as a mobile overlay this sits on top of the
        // conversation, and blur support is unreliable on phones.
        "flex shrink-0 flex-col gap-5 overflow-y-auto border-ink-700 bg-ink-900 p-5 animate-fade md:bg-ink-900/70",
        className ?? "w-80 border-l",
      )}
      style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
    >
      <div className="flex items-start justify-between">
        <Link href={`/characters/${character.id}`} className="group flex items-center gap-3">
          <Avatar
            name={character.name}
            src={character.avatar_url}
            className="h-12 w-12 text-lg"
          />
          <div>
            <h3 className="font-display font-semibold leading-tight group-hover:text-ember-300">
              {character.name}
            </h3>
            <p className="text-xs text-mist">{character.kind === "scenario" ? t("chat.panel.kindScenario") : t("chat.panel.kindCharacter")}</p>
          </div>
        </Link>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-mist hover:bg-ink-700 hover:text-parchment"
          aria-label={t("chat.panel.closeAriaLabel")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {persona && (
        <div className="text-sm text-mist">
          {t("chat.panel.youArePlaying")} <span className="font-display font-semibold text-parchment-dim">{persona.name}</span>
        </div>
      )}

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
      </Field>

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
          onChange={(e) => setDirective(e.target.value)}
          onBlur={saveDirective}
          placeholder={t("chat.panel.directive.placeholder")}
        />
        {directive.trim() !== (conversation.author_note ?? "") && (
          <button className="btn btn-ghost mt-2 w-full !py-1.5 text-xs" onClick={saveDirective}>
            {t("chat.panel.directive.applyButton")}
          </button>
        )}
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="ui-label">{t("chat.panel.summary.title")}</span>
          <button
            className="btn btn-ghost !px-2.5 !py-1 text-xs"
            onClick={generateSummary}
            disabled={summarizing}
            title={t("chat.panel.summary.generateTitle")}
          >
            {summarizing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <NotebookPen className="h-3.5 w-3.5" />
            )}
            {t("chat.panel.summary.generateButton")}
          </button>
        </div>
        <textarea
          className="field min-h-32 text-sm"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder={t("chat.panel.summary.placeholder")}
        />
        {summary !== conversation.summary && (
          <button className="btn btn-ghost mt-2 w-full !py-1.5 text-xs" onClick={saveSummary}>
            {t("chat.panel.summary.saveButton")}
          </button>
        )}
        {note && <p className="mt-1.5 text-xs text-moss">{note}</p>}
      </div>

      {/* Established facts */}
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="ui-label">{t("chat.panel.facts.title")} {memories.length > 0 && `(${memories.length})`}</span>
          <div className="flex gap-1">
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
        {dormant.size > 0 && (
          <p className="mb-2 rounded-lg border border-ember-600/40 bg-ember-glow px-2.5 py-1.5 text-xs leading-relaxed text-ember-300">
            {t("chat.panel.facts.dormantWarning", {
              count: dormant.size,
              consolidateLabel: t("chat.panel.facts.consolidateButton"),
            })}
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          {memories.map((memory) => (
            <div
              key={memory.id}
              className={clsx(
                "group/fact flex items-start gap-1.5 rounded-lg border px-2.5 py-1.5",
                dormant.has(memory.id)
                  ? "border-ink-800 bg-ink-950/40 opacity-45"
                  : "border-ink-700 bg-ink-900/60",
              )}
              title={dormant.has(memory.id) ? t("chat.panel.facts.dormantTitle") : undefined}
            >
              <button
                onClick={() => togglePin(memory)}
                title={memory.is_pinned ? t("chat.panel.facts.unpinTitle") : t("chat.panel.facts.pinTitle")}
                className={clsx(
                  "mt-0.5 shrink-0 transition-colors",
                  memory.is_pinned ? "text-ember-400" : "text-mist-dim hover:text-parchment",
                )}
              >
                <Pin className={clsx("h-3.5 w-3.5", memory.is_pinned && "fill-current")} />
              </button>
              <span className="min-w-0 flex-1 text-[0.82rem] leading-snug text-parchment-dim">
                {memory.content}
                {memory.source_position > 0 && (
                  <span className="ml-1 text-[0.68rem] text-mist-dim">{t("chat.panel.facts.turnBadge", { turn: memory.source_position })}</span>
                )}
              </span>
              <button
                onClick={() => removeFact(memory)}
                className="mt-0.5 shrink-0 text-mist-dim opacity-0 transition-all hover:text-blood group-hover/fact:opacity-100"
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
            className="btn btn-ghost !px-2.5"
            onClick={addFact}
            disabled={!newFact.trim()}
            aria-label={t("chat.panel.facts.addAriaLabel")}
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        {memoryNote && <p className="mt-1.5 text-xs text-moss">{memoryNote}</p>}
      </div>

      {character.scenario && (
        <div>
          <span className="ui-label mb-1.5 block">{t("chat.panel.sceneAnchor.title")}</span>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-mist">
            {previewMacros(character.scenario, character.name, persona?.name ?? t("chat.panel.sceneAnchor.youFallback"))}
          </p>
        </div>
      )}
    </aside>
  );
}
