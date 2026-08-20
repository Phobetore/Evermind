"use client";

import { useT } from "@/i18n/useT";
import { api } from "@/lib/api";
import { clearDraft, loadDraft, saveDraft } from "@/lib/drafts";
import { clsx } from "clsx";
import { BookOpenText, Loader2, Megaphone, MessageCircle, PenLine, Send, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type MessageMode = "say" | "narrate" | "ooc";

/** A pointing device that hovers, which in practice means a real keyboard is
 *  attached too. Read at the moment of the keypress rather than remembered. */
const KEYBOARD_QUERY = "(hover: hover) and (pointer: fine)";
const hasKeyboard = () =>
  typeof window === "undefined" || window.matchMedia(KEYBOARD_QUERY).matches;

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
  onSend: (content: string, messageMode: MessageMode) => void;
  onStop: () => void;
  busy: boolean;
  characterName: string;
}) {
  const t = useT();
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<MessageMode>("say");
  const [ghostwriting, setGhostwriting] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  // A phone keyboard has no Shift, so Enter-to-send left no way at all to start
  // a new line. Only a device that actually has a keyboard keeps that shortcut;
  // everywhere else Enter does what its key says and the send button sends.
  // This state drives the hint only. The keypress reads the query live, because
  // a cached answer goes stale the moment someone docks a tablet to a keyboard
  // and the change event is not something every browser reliably fires.
  const [enterSends, setEnterSends] = useState(true);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  useEffect(() => {
    const media = window.matchMedia(KEYBOARD_QUERY);
    const apply = () => setEnterSends(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  // Restore the unsent draft. Runs in an effect (not a lazy initial state) so
  // the server-rendered markup and the first client render stay identical.
  // The draft lives in localStorage, which does not exist on the server, so
  // this is the one place the state genuinely has to be set from an effect.
  useEffect(() => {
    const saved = loadDraft(conversationId);
    if (saved) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
      setValue(saved);
      setRestored(true);
      const timer = setTimeout(() => setRestored(false), 4000);
      return () => clearTimeout(timer);
    }
  }, [conversationId]);

  // Persist on a short delay; the pending write is cancelled on every change,
  // so the empty first render never overwrites the draft being restored.
  useEffect(() => {
    const timer = setTimeout(() => saveDraft(conversationId, value), 400);
    return () => clearTimeout(timer);
  }, [conversationId, value]);

  function submit() {
    const content = value.trim();
    if (!content || busy) return;
    setValue("");
    clearDraft(conversationId);
    onSend(content, mode);
    setMode("say"); // narration and OOC are one-shot by nature
  }

  async function ghostwrite() {
    if (busy || ghostwriting) return;
    setGhostwriting(true);
    setHint(null);
    try {
      const result = await api.post<{ text: string }>(
        `/api/conversations/${conversationId}/impersonate`,
      );
      setValue(result.text);
      ref.current?.focus();
    } catch (e) {
      setHint(e instanceof Error ? e.message : t("chat.input.ghostwriteError"));
      setTimeout(() => setHint(null), 4000);
    }
    setGhostwriting(false);
  }

  return (
    <div
      className="border-t border-ink-700 bg-ink-900 px-4 py-3 md:bg-ink-900/80 md:backdrop-blur"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      <div className="mx-auto flex max-w-3xl items-end gap-2.5">
        <button
          className={clsx("btn btn-ghost h-11 w-11 shrink-0 !rounded-2xl !p-0 sm:h-12 sm:w-12", MODES[mode].color)}
          onClick={() => setMode(MODES[mode].next)}
          disabled={busy}
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
          disabled={busy || ghostwriting}
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
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
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
            disabled={!value.trim()}
            title={t("chat.input.sendTitle")}
          >
            <Send className="h-5 w-5" />
          </button>
        )}
      </div>
      <p className="mx-auto mt-1.5 max-w-3xl text-center text-[0.7rem] text-mist-dim">
        {hint ??
          (restored
            ? t("chat.input.draftRestored")
            : t(enterSends ? "chat.input.hintDefault" : "chat.input.hintTouch"))}
      </p>
    </div>
  );
}
