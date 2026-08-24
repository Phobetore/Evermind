"use client";

import { RpText } from "@/components/chat/RpText";
import { Avatar } from "@/components/ui/Avatar";
import { useT } from "@/i18n/useT";
import { copyText } from "@/lib/utils";
import type { Character, Message, Persona } from "@/types";
import { clsx } from "clsx";
import {
  Check, ChevronLeft, ChevronRight, Copy, GitBranch, Pencil, RefreshCcw, StepForward,
  Trash2, X,
} from "lucide-react";
import { useState } from "react";

export function ChatMessage({
  message,
  character,
  persona,
  isLast,
  busy,
  onSwipe,
  onRegenerate,
  onContinue,
  onEdit,
  onDeleteFrom,
  onBranch,
}: {
  message: Message;
  character: Character;
  persona: Persona | null;
  isLast: boolean;
  busy: boolean;
  onSwipe: (index: number) => void;
  onRegenerate: () => void;
  onContinue: () => void;
  onEdit: (content: string) => void;
  onDeleteFrom: () => void;
  onBranch: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);

  const isUser = message.role === "user";
  const name = isUser ? (persona?.name ?? t("chat.message.youFallback")) : character.name;
  const avatarSrc = isUser ? persona?.avatar_url : character.avatar_url;
  const variants = message.variants;
  const canSwipe = !isUser && variants.length > 1;
  const interrupted = Boolean(message.meta?.interrupted);
  const messageMode = message.meta?.mode as "narrate" | "ooc" | undefined;

  function copy() {
    copyText(message.content).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <div className="group flex gap-3.5 px-1 py-3 animate-fade">
      <Avatar name={name} src={avatarSrc} className="mt-0.5 h-10 w-10 shrink-0 text-lg" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2.5">
          <span
            className={clsx(
              "font-display text-[0.95rem] font-semibold",
              isUser ? "text-parchment-dim" : "text-ember-300",
            )}
          >
            {name}
          </span>
          {messageMode === "narrate" && (
            <span className="rounded-full border border-arcane-500/40 bg-arcane-glow px-2 py-0.5 font-display text-[0.62rem] font-medium tracking-wide text-arcane-300">
              {t("chat.message.modeBadge.narrate")}
            </span>
          )}
          {messageMode === "ooc" && (
            <span className="rounded-full border border-ember-600/40 bg-ember-glow px-2 py-0.5 font-display text-[0.62rem] font-medium tracking-wide text-ember-300">
              {t("chat.message.modeBadge.ooc")}
            </span>
          )}
          {interrupted && (
            <span className="text-[0.68rem] uppercase tracking-wide text-mist-dim">{t("chat.message.interrupted")}</span>
          )}

          {/* Revealed on hover (desktop), always visible on touch */}
          <div className="hover-actions ml-auto flex items-center gap-0.5">
            {!isUser && isLast && !busy && (
              <>
                <IconButton title={t("chat.message.regenerateTitle")} onClick={onRegenerate}>
                  <RefreshCcw className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton title={t("chat.message.continueTitle")} onClick={onContinue}>
                  <StepForward className="h-3.5 w-3.5" />
                </IconButton>
              </>
            )}
            <IconButton
              title={t("chat.message.editTitle")}
              onClick={() => {
                setDraft(message.content);
                setEditing(true);
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton title={copied ? t("chat.message.copiedTitle") : t("chat.message.copyTitle")} onClick={copy}>
              {copied ? <Check className="h-3.5 w-3.5 text-moss" /> : <Copy className="h-3.5 w-3.5" />}
            </IconButton>
            {!busy && (
              <IconButton title={t("chat.message.branchTitle")} onClick={onBranch}>
                <GitBranch className="h-3.5 w-3.5" />
              </IconButton>
            )}
            <IconButton title={t("chat.message.deleteFromTitle")} onClick={onDeleteFrom} danger>
              <Trash2 className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        </div>

        <div className="mt-1">
          {editing ? (
            <div className="flex flex-col gap-2">
              <textarea
                className="field min-h-28"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  className="btn btn-primary !py-1.5 text-xs"
                  onClick={() => {
                    onEdit(draft);
                    setEditing(false);
                  }}
                >
                  <Check className="h-3.5 w-3.5" /> {t("common.save")}
                </button>
                <button className="btn btn-ghost !py-1.5 text-xs" onClick={() => setEditing(false)}>
                  <X className="h-3.5 w-3.5" /> {t("common.cancel")}
                </button>
              </div>
            </div>
          ) : messageMode === "narrate" ? (
            <p className="whitespace-pre-wrap italic leading-relaxed text-arcane-300/90">
              {message.content}
            </p>
          ) : messageMode === "ooc" ? (
            <p className="whitespace-pre-wrap rounded-lg border border-dashed border-ink-600 bg-ink-900/60 px-3 py-2 text-sm leading-relaxed text-mist">
              {message.content}
            </p>
          ) : (
            <RpText text={message.content} />
          )}
        </div>

        {/* Swipes */}
        {canSwipe && !editing && (
          <div className="mt-1.5 flex items-center gap-1.5 text-mist-dim">
            <button
              className="rounded p-1.5 transition-colors hover:text-parchment disabled:opacity-30 md:p-0.5"
              disabled={message.active_index === 0 || busy}
              onClick={() => onSwipe(message.active_index - 1)}
              aria-label={t("chat.message.prevVariantAriaLabel")}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="font-mono text-[0.7rem]">
              {message.active_index + 1}/{variants.length}
            </span>
            <button
              className="rounded p-1.5 transition-colors hover:text-parchment disabled:opacity-30 md:p-0.5"
              disabled={busy || (message.active_index === variants.length - 1 && !isLast)}
              onClick={() => {
                if (message.active_index < variants.length - 1) onSwipe(message.active_index + 1);
                else onRegenerate();
              }}
              aria-label={t("chat.message.nextVariantAriaLabel")}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function IconButton({
  children,
  title,
  onClick,
  danger = false,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={clsx(
        "rounded-md p-1.5 text-mist-dim transition-colors",
        danger ? "hover:bg-blood/15 hover:text-blood" : "hover:bg-ink-700 hover:text-parchment",
      )}
    >
      {children}
    </button>
  );
}
