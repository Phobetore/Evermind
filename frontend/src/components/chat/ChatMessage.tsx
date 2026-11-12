import { RpText } from "@/components/chat/RpText";
import { Avatar } from "@/components/ui/Avatar";
import { useConfirm } from "@/components/ui/Confirm";
import { useT } from "@/i18n/useT";
import { isCutShort } from "@/lib/cutShort";
import { copyText, nothingFocused } from "@/lib/utils";
import type { Character, Message, Persona } from "@/types";
import { clsx } from "clsx";
import {
  Check, ChevronLeft, ChevronRight, Copy, GitBranch, Loader2, Pencil, RefreshCcw, StepForward,
  Trash2, X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function ChatMessage({
  message,
  character,
  persona,
  isLast,
  busy,
  replyRef,
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
  /** Its Regenerate button, for the focus to come back to once a reply is written. */
  replyRef?: React.Ref<HTMLButtonElement>;
  onSwipe: (index: number) => void;
  onRegenerate: () => void;
  onContinue: () => void;
  /** Whether the server took it: if not, the rewrite stays open. `index` is the version it was opened on. */
  onEdit: (content: string, index: number) => Promise<boolean>;
  onDeleteFrom: () => Promise<unknown>;
  onBranch: () => Promise<unknown>;
}) {
  const t = useT();
  // The version being rewritten: a swipe that lands meanwhile changes the one shown, not this.
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  // A branch or a cut on its way: seen to be, and not asked for a second time meanwhile.
  const [working, setWorking] = useState<"branch" | "delete" | null>(null);

  const confirm = useConfirm();

  /** Asked before the work is marked as under way: while the box is open the button stays enabled,
   *  so that a No hands the focus back to it, and no spinner shows for what nobody has agreed to. */
  async function act(what: "branch" | "delete", action: () => Promise<unknown>) {
    const asked = what === "delete"
      ? await confirm(t("chat.message.confirmDeleteFrom"), { action: t("common.delete"), danger: true })
      : await confirm(t("chat.message.confirmBranch"), { action: t("chat.message.branchAction") });
    if (!asked) return;
    setWorking(what);
    try {
      await action();
    } finally {
      setWorking(null);
    }
  }

  const isUser = message.role === "user";
  const name = isUser ? (persona?.name ?? t("chat.message.youFallback")) : character.name;
  const avatarSrc = isUser ? persona?.avatar_url : character.avatar_url;
  const variants = message.variants;
  const canSwipe = !isUser && variants.length > 1;
  const interrupted = isCutShort(message);
  const messageMode = message.meta?.mode as "narrate" | "ooc" | undefined;

  const editButton = useRef<HTMLButtonElement>(null);
  const previous = useRef<HTMLButtonElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  // An arrow that its swipe disables gives the focus to the other, once the swipe has landed.
  const swiping = useRef(false);
  useEffect(() => {
    if (swiping.current && nothingFocused()) (message.active_index === 0 ? next : previous).current?.focus();
    swiping.current = false;
  }, [message.active_index]);

  function swipe(index: number) {
    swiping.current = true;
    onSwipe(index);
  }

  async function save() {
    if (editing !== null && (await onEdit(draft, editing))) closeEditor();
  }

  /** Back to Edit, rather than to the page, unless the focus went elsewhere meanwhile. */
  function closeEditor() {
    const here = document.activeElement;
    setEditing(null);
    if (nothingFocused() || here?.closest(`[data-message-id="${message.id}"]`)) editButton.current?.focus();
  }

  function copy() {
    if (!copyText(message.content)) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    // Named so a test can point at one message rather than at a run of its
    // text, which asterisks turn into several elements.
    <div data-message-id={message.id} className="group flex gap-3.5 px-1 py-3 animate-fade">
      <Avatar name={name} src={avatarSrc} className="mt-0.5 h-10 w-10 shrink-0 text-lg" />
      <div className="min-w-0 flex-1">
        {/* Wraps, for the sake of a touch screen: six buttons of 44px are wider
            than the name and the column beside it on some phones. */}
        <div className="flex flex-wrap items-baseline gap-x-2.5 pointer-coarse:items-center">
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

          {/* Always shown on touch, each button 44px across and the row giving back the height it takes;
              six that do not fit on a line break between the reply's two and the message's four. */}
          <div className="hover-actions ml-auto flex items-center gap-0.5 pointer-coarse:-my-2.5 pointer-coarse:flex-wrap pointer-coarse:justify-end pointer-coarse:gap-0">
            {isLast && !busy && (
              <div className="flex items-center gap-0.5 pointer-coarse:gap-0">
                {/* On a message of the person's, the reply it is waiting for. Never on a greeting: it answers nothing. */}
                {!message.meta?.greeting && (
                  <IconButton ref={replyRef} title={t("chat.message.regenerateTitle")} onClick={onRegenerate}>
                    <RefreshCcw className="h-3.5 w-3.5" />
                  </IconButton>
                )}
                {!isUser && (
                  <IconButton title={t("chat.message.continueTitle")} onClick={onContinue}>
                    <StepForward className="h-3.5 w-3.5" />
                  </IconButton>
                )}
              </div>
            )}
            <div className="flex items-center gap-0.5 pointer-coarse:gap-0">
              <IconButton
                ref={editButton}
                title={t("chat.message.editTitle")}
                onClick={() => {
                  setDraft(message.content);
                  setEditing(message.active_index);
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton title={copied ? t("chat.message.copiedTitle") : t("chat.message.copyTitle")} onClick={copy}>
                {copied ? <Check className="h-3.5 w-3.5 text-moss" /> : <Copy className="h-3.5 w-3.5" />}
              </IconButton>
              {!busy && (
                <IconButton
                  title={t("chat.message.branchTitle")}
                  onClick={() => act("branch", onBranch)}
                  disabled={working !== null}
                >
                  {working === "branch"
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <GitBranch className="h-3.5 w-3.5" />}
                </IconButton>
              )}
              <IconButton
                title={t("chat.message.deleteFromTitle")}
                onClick={() => act("delete", onDeleteFrom)}
                disabled={working !== null}
                danger
              >
                {working === "delete"
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Trash2 className="h-3.5 w-3.5" />}
              </IconButton>
            </div>
          </div>
        </div>

        <div className="mt-1">
          {editing !== null ? (
            <div className="flex flex-col gap-2">
              <textarea
                className="field min-h-28"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") closeEditor();
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void save();
                  }
                }}
                autoFocus
              />
              <div className="flex gap-2">
                <button className="btn btn-primary !py-1.5 text-xs" onClick={save}>
                  <Check className="h-3.5 w-3.5" /> {t("common.save")}
                </button>
                <button className="btn btn-ghost !py-1.5 text-xs" onClick={closeEditor}>
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

        {/* Swipes. 44px buttons on a touch screen, and the row gives the height back. */}
        {canSwipe && editing === null && (
          <div className="mt-1.5 flex items-center gap-1.5 text-mist-dim pointer-coarse:mt-0 pointer-coarse:-mb-2.5 pointer-coarse:gap-0">
            <button
              ref={previous}
              className="rounded p-1.5 transition-colors hover:text-parchment disabled:opacity-30 md:p-0.5 pointer-coarse:p-3.5 md:pointer-coarse:p-3.5"
              disabled={message.active_index === 0 || busy}
              onClick={() => swipe(message.active_index - 1)}
              aria-label={t("chat.message.prevVariantAriaLabel")}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="font-mono text-[0.7rem]">
              {message.active_index + 1}/{variants.length}
            </span>
            <button
              ref={next}
              className="rounded p-1.5 transition-colors hover:text-parchment disabled:opacity-30 md:p-0.5 pointer-coarse:p-3.5 md:pointer-coarse:p-3.5"
              disabled={busy || (message.active_index === variants.length - 1 && (!isLast || Boolean(message.meta?.greeting)))}
              onClick={() => {
                if (message.active_index < variants.length - 1) swipe(message.active_index + 1);
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
  disabled = false,
  ref,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "rounded-md p-1.5 text-mist-dim transition-colors disabled:cursor-wait pointer-coarse:p-[15px]",
        danger ? "hover:bg-blood/15 hover:text-blood" : "hover:bg-ink-700 hover:text-parchment",
      )}
    >
      {children}
    </button>
  );
}
