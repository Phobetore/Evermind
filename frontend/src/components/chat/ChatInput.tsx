import { ModelSilent } from "@/components/chat/ModelSilent";
import { DataError, data } from "@/data";
import { useT } from "@/i18n/useT";
import { clearDraft, loadDraft, openBox, saveDraft, type MessageMode } from "@/lib/drafts";
import { describeError } from "@/lib/errors";
import { clsx } from "clsx";
import { BookOpenText, Loader2, Megaphone, MessageCircle, PenLine, Send, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** A pointing device that hovers, which in practice means a real keyboard is
 *  attached too. Read at the moment of the keypress rather than remembered. */
const hasKeyboard = () => window.matchMedia("(hover: hover) and (pointer: fine)").matches;

const MODES: Record<MessageMode, {
  next: MessageMode;
  icon: typeof MessageCircle;
  labelKey: string;
  color: string;
  placeholderKey: string;
}> = {
  say: {
    next: "narrate",
    icon: MessageCircle,
    labelKey: "chat.input.modes.say.label",
    color: "text-mist",
    placeholderKey: "chat.input.modes.say.placeholder",
  },
  narrate: {
    next: "ooc",
    icon: BookOpenText,
    labelKey: "chat.input.modes.narrate.label",
    color: "text-arcane-300 border-arcane-500/60 bg-arcane-glow",
    placeholderKey: "chat.input.modes.narrate.placeholder",
  },
  ooc: {
    next: "say",
    icon: Megaphone,
    labelKey: "chat.input.modes.ooc.label",
    color: "text-ember-300 border-ember-500/60 bg-ember-glow",
    placeholderKey: "chat.input.modes.ooc.placeholder",
  },
};

export function ChatInput({
  conversationId,
  onSend,
  onStop,
  busy,
  characterName,
}: {
  conversationId: string;
  /** Whether the server has the message, which leaves the box only then. */
  onSend: (content: string, messageMode: MessageMode) => Promise<boolean>;
  onStop: () => void;
  busy: boolean;
  characterName: string;
}) {
  const t = useT();
  // The page keys this by conversation, so each conversation gets an input of its
  // own and its unsent draft is read once, as the input appears.
  const [value, setValue] = useState(() => loadDraft(conversationId));
  const [mode, setMode] = useState<MessageMode>("say");
  const [sending, setSending] = useState(false);
  const [ghostwriting, setGhostwriting] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  // Stays until the next attempt, rather than fading: something has to be
  // switched on before trying again is worth anything.
  const [silent, setSilent] = useState(false);
  const [restored, setRestored] = useState(value !== "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const held = useRef({ value, mode });
  // The pen's last suggestion, which pressing it again replaces while it is as written.
  const suggested = useRef("");

  useEffect(() => {
    held.current = { value, mode };
  }, [value, mode]);

  useEffect(
    () => openBox(conversationId, {
      read: () => held.current.value,
      write(text, nextMode = held.current.mode) {
        held.current = { value: text, mode: nextMode };
        setValue(text);
        setMode(nextMode);
        setRestored(text.trim() !== "");
      },
    }),
    [conversationId],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  // The notice that a draft came back, for a few seconds.
  useEffect(() => {
    if (!restored) return;
    const timer = setTimeout(() => setRestored(false), 4000);
    return () => clearTimeout(timer);
  }, [restored]);

  /** Kept as it is typed: a phone can drop the page at any moment. */
  function change(text: string) {
    setValue(text);
    saveDraft(conversationId, text);
  }

  async function submit() {
    const content = value.trim();
    if (!content || busy || sending) return;
    // The reply about to be asked for reports its own silence, in the
    // conversation. Two of these on screen at once is the fuss this was
    // supposed to avoid.
    setSilent(false);
    change(content);
    suggested.current = ""; // sent, it is the person's message, refused or not
    setSending(true);
    const sent = await onSend(content, mode);
    setSending(false);
    if (!sent) return;
    setValue("");
    clearDraft(conversationId);
    setMode("say"); // narration and OOC are one-shot by nature
    held.current = { value: "", mode: "say" };
  }

  async function ghostwrite() {
    if (busy || sending || ghostwriting) return;
    setGhostwriting(true);
    setHint(null);
    setSilent(false);
    try {
      const result = await data.turns.impersonate(conversationId);
      const last = suggested.current;
      suggested.current = result.text;
      // Under what the box holds, which is where a message given back to it is looked for.
      const box = held.current.value;
      const kept = last && box.endsWith(last) ? box.slice(0, -last.length).trimEnd() : box;
      change(kept.trim() ? `${kept}\n${result.text}` : result.text);
      ref.current?.focus();
    } catch (e) {
      // The model saying nothing is not the same as a mistake, and it used to
      // land in the hint line for four seconds, where the keyboard tip lives.
      if (e instanceof DataError && e.kind === "unreachable") {
        setSilent(true);
      } else {
        setHint(describeError(e, t, t("chat.input.ghostwriteError")));
        setTimeout(() => setHint(null), 4000);
      }
    }
    setGhostwriting(false);
  }

  return (
    <div
      className="border-t border-ink-700 bg-ink-900 px-4 py-3 md:bg-ink-900/80 md:backdrop-blur"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      {/* Right above the box, which is where you were looking when you asked. */}
      {silent && (
        <div className="mb-2.5">
          <ModelSilent onRetry={ghostwrite} />
        </div>
      )}
      <div className="mx-auto flex max-w-3xl items-end gap-2.5">
        <button
          className={clsx("btn btn-ghost h-11 w-11 shrink-0 !rounded-2xl !p-0 sm:h-12 sm:w-12", MODES[mode].color)}
          onClick={() => setMode(MODES[mode].next)}
          disabled={busy || sending}
          title={t(MODES[mode].labelKey)}
        >
          {(() => {
            const Icon = MODES[mode].icon;
            return <Icon className="h-4.5 w-4.5" />;
          })()}
        </button>
        <button
          className="btn btn-ghost h-11 w-11 shrink-0 !rounded-2xl !p-0 sm:h-12 sm:w-12"
          onClick={ghostwrite}
          disabled={busy || sending || ghostwriting}
          title={t("chat.input.ghostwriteTitle")}
        >
          {ghostwriting ? (
            <Loader2 className="h-4.5 w-4.5 animate-spin" />
          ) : (
            <PenLine className="h-4.5 w-4.5" />
          )}
        </button>
        <textarea
          ref={ref}
          value={value}
          readOnly={sending}
          onChange={(e) => change(e.target.value)}
          onKeyDown={(e) => {
            // A phone keyboard has no Shift, so there Enter is the only way to a new line.
            if (e.key === "Enter" && !e.shiftKey && hasKeyboard()) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder={t(MODES[mode].placeholderKey, { name: characterName })}
          className={clsx(
            "field max-h-56 flex-1 !rounded-2xl !py-3 leading-relaxed",
            mode === "narrate" && "!border-arcane-500/50",
            mode === "ooc" && "!border-ember-500/50",
          )}
        />
        {busy ? (
          <button
            className="btn btn-ghost h-11 w-11 shrink-0 !rounded-2xl !p-0 sm:h-12 sm:w-12"
            onClick={onStop}
            title={t("chat.input.stopTitle")}
          >
            <Square className="h-4.5 w-4.5 fill-current" />
          </button>
        ) : (
          <button
            className="btn btn-primary h-11 w-11 shrink-0 !rounded-2xl !p-0 sm:h-12 sm:w-12"
            onClick={submit}
            disabled={!value.trim() || sending}
            title={t("chat.input.sendTitle")}
          >
            {/* Waking on wifi can take a few seconds, and the message waits here for the server. */}
            {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
          </button>
        )}
      </div>
      <p className="mx-auto mt-1.5 max-w-3xl text-center text-[0.7rem] text-mist-dim">
        {hint ??
          (restored
            ? t("chat.input.draftRestored")
            : t(hasKeyboard() ? "chat.input.hintDefault" : "chat.input.hintTouch"))}
      </p>
    </div>
  );
}
