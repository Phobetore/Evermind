import { useCallback, useEffect, useState } from "react";

/** Long enough to read a line; with a button, to read it and reach for the button too. */
const PLAIN_MS = 4200;
const WITH_ACTION_MS = 9000;

type Action = { label: string; run(): void };

/** The line over the input for whatever the conversation says in passing. A new one replaces the
 *  one shown; `node` is drawn with the input, out of the story that scrolls. */
export function useChatToast(): { toast(text: string, action?: Action): void; node: React.ReactNode } {
  // Each toast its own, so that the same words said twice start their time again.
  const [shown, setShown] = useState<{ text: string; action?: Action; at: number } | null>(null);

  const toast = useCallback((text: string, action?: Action) => {
    setShown({ text, action, at: performance.now() });
  }, []);

  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(null), shown.action ? WITH_ACTION_MS : PLAIN_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  const node = shown && (
    <div
      key={shown.at}
      data-chat-toast
      role="status"
      className="mx-auto mb-2.5 flex max-w-3xl flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-xs text-parchment-dim animate-fade"
    >
      <span className="min-w-0 [overflow-wrap:anywhere]">{shown.text}</span>
      {shown.action && (
        <button
          type="button"
          className="btn btn-ghost touch-target !py-1 text-xs"
          onClick={() => {
            const { run } = shown.action!;
            setShown(null);
            run();
          }}
        >
          {shown.action.label}
        </button>
      )}
    </div>
  );
  return { toast, node };
}
