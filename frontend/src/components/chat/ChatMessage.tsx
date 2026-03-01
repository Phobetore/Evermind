"use client";

import type { AssistantMeta, Message, UserPersona } from "@/types";
import { useState } from "react";
import { Check, Copy, Pencil, RotateCcw, X } from "lucide-react";
import { parseRPContent, type RPSegment } from "@/lib/rp-parser";
import CharacterAvatar from "@/components/ui/CharacterAvatar";

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

function asAssistantMeta(meta: Message["meta"]): AssistantMeta {
  if (meta && typeof meta === "object") {
    return meta as AssistantMeta;
  }
  return {};
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Render a single line of RP-formatted content with visual styling. */
function RPContent({ text, isUser = false }: { text: string; isUser?: boolean }) {
  const segments = parseRPContent(text);
  return (
    <>
      {segments.map((seg: RPSegment, i: number) => {
        if (seg.type === "action") {
          return (
            <span key={i} className={isUser ? "italic text-white/80" : "italic text-violet-300"}>
              {seg.text}
            </span>
          );
        }
        if (seg.type === "context") {
          return (
            <span key={i} className={isUser ? "text-white/70 text-xs bg-white/10 rounded px-1 py-0.5" : "text-zinc-400 text-xs bg-white/5 rounded px-1 py-0.5"}>
              {seg.text}
            </span>
          );
        }
        return <span key={i}>{seg.text}</span>;
      })}
    </>
  );
}

interface Props {
  message: Message;
  characterName: string;
  isLast?: boolean;
  onRegenerate?: () => void;
  onEditMessage?: (messageId: string, newContent: string) => void;
  userPersona?: UserPersona | null;
}

export default function ChatMessage({
  message,
  characterName,
  isLast,
  onRegenerate,
  onEditMessage,
  userPersona,
}: Props) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content);
  const [showWhy, setShowWhy] = useState(false);
  const meta = asAssistantMeta(message.meta);

  function handleCopy() {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleEditSave() {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== message.content && onEditMessage) {
      onEditMessage(message.id, trimmed);
    }
    setEditing(false);
  }

  function handleEditCancel() {
    setEditValue(message.content);
    setEditing(false);
  }

  function handleEditKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleEditSave();
    }
    if (e.key === "Escape") {
      handleEditCancel();
    }
  }

  if (isSystem) {
    return (
      <div className="text-center text-xs text-zinc-500 py-2">
        {message.content}
      </div>
    );
  }

  const words = meta.quality_signals?.response_words;
  const repetition = meta.quality_signals?.repetition_ratio;
  const diversity = meta.quality_signals?.lexical_diversity;
  const qualityMode = meta.pipeline?.quality_mode;
  const memoryUsed = meta.retrieval?.selected_n;
  const memorySummaries = meta.retrieval?.memory_summaries ?? [];
  const canShowWhy = !isUser && memorySummaries.length > 0;
  const scoringFormula = meta.retrieval?.scoring?.formula;

  return (
    <div className={`group flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      {/* Avatar */}
      {isUser && userPersona?.avatar_path ? (
        <img
          src={`/api/user_personas/${userPersona.id}/avatar/file`}
          alt={userPersona.name}
          className="h-8 w-8 rounded-full object-cover shrink-0"
        />
      ) : (
        <CharacterAvatar
          name={isUser ? (userPersona?.name ?? "U") : characterName}
          size="sm"
          flat={isUser}
        />
      )}

      {/* Bubble */}
      <div className="flex flex-col max-w-[75%]">
        <div
          className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
            isUser
              ? "bg-violet-600 text-white"
              : "bg-surface-light text-zinc-100"
          }`}
        >
          {isUser ? (
            editing ? (
              <div className="space-y-2">
                <textarea
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={handleEditKeyDown}
                  className="w-full bg-violet-700 text-white rounded-lg px-2 py-1 text-sm resize-none min-h-[40px] focus:outline-none focus:ring-1 focus:ring-violet-300"
                  rows={2}
                  autoFocus
                />
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={handleEditCancel}
                    className="text-xs text-violet-200 hover:text-white transition-colors flex items-center gap-1"
                  >
                    <X size={12} /> Cancel
                  </button>
                  <button
                    onClick={handleEditSave}
                    disabled={!editValue.trim()}
                    className="text-xs text-violet-200 hover:text-white transition-colors flex items-center gap-1 disabled:opacity-50"
                  >
                    <Check size={12} /> Save &amp; Resend
                  </button>
                </div>
              </div>
            ) : (
              message.content.split("\n").map((line, i) => (
                <p key={i} className={i > 0 ? "mt-2" : ""}>
                  {line ? <RPContent text={line} isUser /> : "\u00A0"}
                </p>
              ))
            )
          ) : (
            message.content.split("\n").map((line, i) => (
              <p key={i} className={`${i > 0 ? "mt-2" : ""} last:mb-0`}>
                {line ? <RPContent text={line} /> : "\u00A0"}
              </p>
            ))
          )}
        </div>

        {!isUser && (words || repetition !== undefined || diversity !== undefined || qualityMode || memoryUsed) && (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {qualityMode && (
              <span className="rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-violet-200">
                {qualityMode}
              </span>
            )}
            {typeof words === "number" && (
              <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] text-zinc-300">
                {words} words
              </span>
            )}
            {typeof diversity === "number" && (
              <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] text-zinc-300">
                diversity {diversity.toFixed(2)}
              </span>
            )}
            {typeof repetition === "number" && (
              <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] text-zinc-300">
                repetition {(repetition * 100).toFixed(0)}%
              </span>
            )}
            {typeof memoryUsed === "number" && (
              <span
                className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] text-zinc-300"
                title={
                  memorySummaries.length > 0
                    ? memorySummaries
                        .slice(0, 6)
                        .map((m) => `${m.type ?? "memory"}: ${m.title ?? "(untitled)"} (score ${toNumber(m.score).toFixed(2)})`)
                        .join("\n")
                    : undefined
                }
              >
                memories {memoryUsed}
              </span>
            )}
            {canShowWhy && (
              <button
                type="button"
                onClick={() => setShowWhy((v) => !v)}
                aria-expanded={showWhy}
                aria-controls={`memory-why-${message.id}`}
                title="Show memory selection reasons"
                className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] text-zinc-300 hover:border-violet-500/50"
              >
                {showWhy ? "hide why" : "why"}
              </button>
            )}
          </div>
        )}
        {canShowWhy && showWhy && (
          <div id={`memory-why-${message.id}`} className="mt-2 rounded-xl border border-border/70 bg-surface/70 p-2.5 space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-zinc-500">Memory reasons</p>
            {scoringFormula && (
              <p className="text-[10px] text-zinc-500">Scoring: {scoringFormula}</p>
            )}
            {memorySummaries.slice(0, 5).map((m, i) => {
              const score = toNumber(m.score);
              const importance = toNumber(m.importance);
              const confidence = toNumber(m.confidence);
              const rank = toNumber(m.rank, i + 1);
              return (
                <div key={m.id ?? `${i}-${m.title ?? "memory"}`} className="text-[11px] text-zinc-300 leading-snug">
                  <span className="text-zinc-500">#{rank} {m.type ?? "memory"}</span>{" "}
                  <span className="text-zinc-100">{m.title ?? "(untitled)"}</span>{" "}
                  <span className="text-zinc-500">(score {score.toFixed(2)}, imp {importance.toFixed(2)}, conf {confidence.toFixed(2)})</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Timestamp + Actions */}
        <div
          className={`flex items-center gap-2 mt-1 opacity-0 group-hover:opacity-100 transition-opacity ${
            isUser ? "flex-row-reverse" : ""
          }`}
        >
          <span className="text-[10px] text-zinc-600" title={new Date(message.created_at).toLocaleString()}>
            {formatRelativeTime(message.created_at)}
          </span>

          <button
            onClick={handleCopy}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            title="Copy message"
          >
            {copied ? <><Check size={12} className="inline" /> Copied</> : <><Copy size={12} className="inline" /> Copy</>}
          </button>

          {isUser && onEditMessage && !editing && (
            <button
              onClick={() => setEditing(true)}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              title="Edit message"
            >
              <Pencil size={12} className="inline" /> Edit
            </button>
          )}

          {!isUser && isLast && onRegenerate && (
            <button
              onClick={onRegenerate}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              title="Regenerate"
            >
              <RotateCcw size={12} className="inline" /> Regenerate
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
