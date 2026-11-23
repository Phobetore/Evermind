import { ModelSilent } from "@/components/chat/ModelSilent";
import { DataError, data } from "@/data";
import { useT } from "@/i18n/useT";
import { inputScale, useDisplay } from "@/lib/display";
import { loadDraft, openBox, saveDraft, type MessageMode } from "@/lib/drafts";
import { describeError } from "@/lib/errors";
import { onItsWay } from "@/lib/useTurn";
import { clsx } from "clsx";
import { BookOpenText, Loader2, Megaphone, MessageCircle, PenLine, Plus, Send, Square } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** A pointing device that hovers, which in practice means a real keyboard is
 *  attached too. Read at the moment of the keypress rather than remembered. */
const hasKeyboard = () => window.matchMedia("(hover: hover) and (pointer: fine)").matches;

/** The most lines the box grows to before its text scrolls in it. */
const LINES = 6;
/** Nor more than this share of the visible height: at 200 % of the system's text, six lines would cover the screen. */
const MOST_OF_SCREEN = 0.4;

const MODES: Record<MessageMode, {
  next: MessageMode;
  icon: typeof MessageCircle;
  labelKey: string;
  /** The mode's short name, on the button of the folded row, which a finger reads rather than hovers. */
  shortKey: string;
  color: string;
  placeholderKey: string;
}> = {
  say: {
    next: "narrate",
    icon: MessageCircle,
    labelKey: "chat.input.modes.say.label",
    shortKey: "chat.input.modes.say.short",
    color: "text-mist",
    placeholderKey: "chat.input.modes.say.placeholder",
  },
  narrate: {
    next: "ooc",
    icon: BookOpenText,
    labelKey: "chat.input.modes.narrate.label",
    shortKey: "chat.input.modes.narrate.short",
    color: "text-arcane-300 border-arcane-500/60 bg-arcane-glow",
    placeholderKey: "chat.input.modes.narrate.placeholder",
  },
  ooc: {
    next: "say",
    icon: Megaphone,
    labelKey: "chat.input.modes.ooc.label",
    shortKey: "chat.input.modes.ooc.short",
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
  stopRef,
}: {
  conversationId: string;
  /** Settles at the server's answer, which takes the message out of whichever box shows it, or at patience's end. */
  onSend: (content: string, messageMode: MessageMode) => Promise<unknown>;
  onStop: () => void;
  busy: boolean;
  characterName: string;
  stopRef?: React.Ref<HTMLButtonElement>;
}) {
  const t = useT();
  // The page is keyed by conversation: the unsent draft is read once, as the input appears.
  const [value, setValue] = useState(() => loadDraft(conversationId));
  const [mode, setMode] = useState<MessageMode>("say");
  // Sent from this page before it was left and come back to, it may be on its way still.
  const [onTheWay] = useState(() => onItsWay(conversationId));
  const [sending, setSending] = useState(onTheWay !== undefined);
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
    let open = true;
    void onTheWay?.then(() => {
      if (open) setSending(false);
    });
    return () => {
      open = false;
    };
  }, [onTheWay]);

  const scale = inputScale(useDisplay().text);
  /** The height of its text, up to six lines and to 40 % of what the screen shows (the keyboard
   *  takes the rest); past that its text scrolls in it. */
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Empty, it rests at one line: a placeholder that wraps would count in its height.
    if (!el.value) {
      el.style.height = "";
      return;
    }
    const style = getComputedStyle(el);
    const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const lines = LINES * parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + borders;
    const visible = window.visualViewport?.height ?? window.innerHeight;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight + borders, lines, visible * MOST_OF_SCREEN)}px`;
  }, []);
  useLayoutEffect(fit, [value, scale, fit]);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    viewport.addEventListener("resize", fit);
    return () => viewport.removeEventListener("resize", fit);
  }, [fit]);

  // Under 18rem the mode and the pen fold into one button, which opens a row of the two above the line.
  const [folded, setFolded] = useState(false);
  const plus = useRef<HTMLButtonElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const rowMode = useRef<HTMLButtonElement>(null);
  const opening = useRef(false);
  useEffect(() => {
    if (!folded) return;
    if (opening.current) rowMode.current?.focus();
    opening.current = false;
    // A touch anywhere else closes it, and leaves the focus where it was.
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!row.current?.contains(target) && !plus.current?.contains(target)) setFolded(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [folded]);

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
    // The reply about to be asked for reports its own silence, in the conversation: one notice at a time.
    setSilent(false);
    setFolded(false);
    change(content);
    suggested.current = ""; // sent, it is the person's message, refused or not
    setSending(true);
    await onSend(content, mode);
    setSending(false);
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
      if (e instanceof DataError && e.kind === "unreachable") {
        setSilent(true);
      } else {
        setHint(describeError(e, t, t("chat.input.ghostwriteError")));
        setTimeout(() => setHint(null), 4000);
      }
    }
    setGhostwriting(false);
  }

  const ModeIcon = MODES[mode].icon;
  // In px, as the header's: under a root of 32px, sizes in rem would make each button twice as wide.
  const square = "btn btn-ghost size-[44px] min-h-0 shrink-0 !rounded-2xl !p-0 sm:size-[48px]";
  return (
    // A container: under 18rem of its own width the mode and the pen fold into "+", under 240px the
    // box takes a line of its own. Asked of the box, not of the screen: the side panel narrows it too.
    <div
      className="@container border-t border-ink-700 bg-ink-900 px-4 py-3 md:bg-ink-900/80 md:backdrop-blur"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))", "--input-scale": scale } as React.CSSProperties}
    >
      {/* Right above the box, which is where you were looking when you asked. */}
      {silent && (
        <div className="mb-2.5">
          <ModelSilent onRetry={ghostwrite} />
        </div>
      )}
      {/* Two more buttons, not those of the line moved here: drawn only while open, and with no title,
          their text being their name. Hidden from 18rem with "+", and shown again open if the box narrows. */}
      {folded && (
        <div
          ref={row}
          className="mx-auto mb-2.5 flex max-w-3xl gap-[10px] @min-[18rem]:hidden"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            setFolded(false);
            plus.current?.focus();
          }}
        >
          {/* Changing mode leaves the row open: the mode wanted may be two touches away. */}
          <button
            ref={rowMode}
            className={clsx("btn btn-ghost min-w-0 flex-1 !rounded-2xl", MODES[mode].color)}
            onClick={() => setMode(MODES[mode].next)}
            disabled={busy || sending}
          >
            <ModeIcon className="size-[18px] shrink-0" />
            <span className="truncate">{t(MODES[mode].shortKey)}</span>
          </button>
          <button
            className="btn btn-ghost min-w-0 flex-1 !rounded-2xl"
            onClick={() => {
              setFolded(false);
              // Where the words arrive.
              ref.current?.focus();
              void ghostwrite();
            }}
            disabled={busy || sending || ghostwriting}
          >
            <PenLine className="size-[18px] shrink-0" />
            <span className="truncate">{t("chat.input.penLabel")}</span>
          </button>
        </div>
      )}
      <div className="mx-auto flex max-w-3xl items-end gap-[10px] @max-[240px]:flex-wrap">
        <button
          className={clsx(square, "@max-[18rem]:hidden", MODES[mode].color)}
          onClick={() => setMode(MODES[mode].next)}
          disabled={busy || sending}
          title={t(MODES[mode].labelKey)}
        >
          <ModeIcon className="size-[18px]" />
        </button>
        <button
          className={clsx(square, "@max-[18rem]:hidden")}
          onClick={ghostwrite}
          disabled={busy || sending || ghostwriting}
          title={t("chat.input.ghostwriteTitle")}
        >
          {ghostwriting ? (
            <Loader2 className="size-[18px] animate-spin" />
          ) : (
            <PenLine className="size-[18px]" />
          )}
        </button>
        <button
          ref={plus}
          className={clsx(square, "hidden @max-[18rem]:inline-flex")}
          onClick={() => {
            opening.current = !folded;
            setFolded(!folded);
          }}
          onKeyDown={(e) => e.key === "Escape" && setFolded(false)}
          aria-expanded={folded}
          aria-label={t("chat.input.more")}
        >
          <Plus className="size-[18px]" />
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
            "chat-input field min-w-0 flex-1 !rounded-2xl @max-[240px]:order-first @max-[240px]:basis-full",
            mode === "narrate" && "!border-arcane-500/50",
            mode === "ooc" && "!border-ember-500/50",
          )}
        />
        {busy ? (
          <button
            ref={stopRef}
            className={clsx(square, "@max-[240px]:ml-auto")}
            onClick={onStop}
            title={t("chat.input.stopTitle")}
          >
            <Square className="size-[18px] fill-current" />
          </button>
        ) : (
          <button
            className="btn btn-primary size-[44px] min-h-0 shrink-0 !rounded-2xl !p-0 sm:size-[48px] @max-[240px]:ml-auto"
            onClick={submit}
            disabled={!value.trim() || sending}
            title={t("chat.input.sendTitle")}
          >
            {/* Waking on wifi can take a few seconds, and the message waits here for the server. */}
            {sending ? <Loader2 className="size-[20px] animate-spin" /> : <Send className="size-[20px]" />}
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
