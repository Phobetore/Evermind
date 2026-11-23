import { data } from "@/data";
import { PATIENCE_MS } from "@/lib/useTurn";
import type { Backdrop, Conversation } from "@/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** How long a strength must stay still before it is written: a drag moves it on every pixel. */
const SETTLE_MS = 350;

export interface ConversationBackdrop {
  /** Live on every move, written once it settles (350 ms); one the server refuses goes back to
   *  what it holds, unless moved since. A write still waiting is sent at once when the page
   *  unmounts (the back arrow, a link), and on `pagehide` with `outlivePage`, so that
   *  closing the tab does not cut it off. null: follow the device again. */
  setStrength(value: number | null): void;
  /** What the last strength write failed with; null again once a later one is sent, or `forget`. */
  readonly failed: unknown;
  forget(): void;
  /** The panel, which covers the conversation on a phone, says a refusal in its own line.
   *  Resolves null once saved, or to what failed; after a failure the conversation's backdrop
   *  fields are read again from the server (a lost answer may have landed), a failing read
   *  leaving them as they were. */
  choose(backdrop: Backdrop): Promise<unknown>;
}

const backdropFields = (c: Conversation) => ({
  backdrop: c.backdrop,
  backdrop_strength: c.backdrop_strength,
  wallpaper_url: c.wallpaper_url,
  wallpaper_opacity: c.wallpaper_opacity,
});

export function useConversationBackdrop(
  conversation: Conversation | null,
  setConversation: React.Dispatch<React.SetStateAction<Conversation | null>>,
): ConversationBackdrop {
  const [failed, setFailed] = useState<unknown>(null);
  // The conversation as last drawn, for what runs later than the render that set it up.
  const shown = useRef(conversation);
  useEffect(() => {
    shown.current = conversation;
  }, [conversation]);
  // What the server holds, known once something was moved: the strength drawn may be ahead of it.
  const held = useRef<number | null | undefined>(undefined);
  const waiting = useRef<{ id: string; value: number | null } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gone = useRef(false);

  const flush = useCallback((outlivePage: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const write = waiting.current;
    if (!write) return Promise.resolve();
    waiting.current = null;
    if (!gone.current) setFailed(null);
    return data.conversations
      .update(write.id, { backdrop_strength: write.value }, outlivePage ? { outlivePage } : undefined)
      .then(
        () => {
          held.current = write.value;
        },
        (error) => {
          if (gone.current) return;
          setFailed(error);
          const before = held.current;
          if (before === undefined) return;
          setConversation((c) =>
            c && c.id === write.id && c.backdrop_strength === write.value ? { ...c, backdrop_strength: before } : c);
        },
      );
  }, [setConversation]);

  // Leaving by the page itself unmounts it: what is waiting goes at once. Closing the tab does not
  // unmount anything, so pagehide sends it too, in a request that outlives the page.
  useEffect(() => {
    gone.current = false;
    const hide = () => void flush(true);
    window.addEventListener("pagehide", hide);
    return () => {
      window.removeEventListener("pagehide", hide);
      gone.current = true;
      void flush(false);
    };
  }, [flush]);

  const setStrength = useCallback((value: number | null) => {
    const now = shown.current;
    if (!now) return;
    if (held.current === undefined) held.current = now.backdrop_strength;
    setConversation((c) => (c ? { ...c, backdrop_strength: value } : c));
    waiting.current = { id: now.id, value };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(false), SETTLE_MS);
  }, [flush, setConversation]);

  const forget = useCallback(() => setFailed(null), []);

  const choose = useCallback(async (backdrop: Backdrop) => {
    const now = shown.current;
    if (!now) return null;
    // A strength still waiting is sent first: the choice may reset it on the server.
    await flush(false);
    try {
      const saved = await data.conversations.update(now.id, { backdrop });
      held.current = saved.backdrop_strength;
      setConversation((c) => (c ? { ...c, ...backdropFields(saved) } : c));
      return null;
    } catch (error) {
      try {
        const there = await data.conversations.withoutMessages(now.id, { within: PATIENCE_MS });
        held.current = there.backdrop_strength;
        setConversation((c) => (c ? { ...c, ...backdropFields(there) } : c));
      } catch {
        /* what is drawn stays as it was */
      }
      return error;
    }
  }, [flush, setConversation]);

  return useMemo(() => ({ setStrength, failed, forget, choose }), [setStrength, failed, forget, choose]);
}
