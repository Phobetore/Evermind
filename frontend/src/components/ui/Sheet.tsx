import { useT } from "@/i18n/useT";
import { clsx } from "clsx";
import { Loader2, X } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";

/** A sheet that rises from the bottom edge: the browser's modal dialog, as Modal is. Below md,
 *  the full width, rounded top corners; from md, at the bottom, centred, 28rem wide. At most 90 %
 *  of the visible height (60 % with `seeThrough`); past that its body scrolls inside it
 *  (overscroll-behavior: contain), the title row staying in sight. `seeThrough`: no shade over the
 *  page, for a setting judged on what is behind it. `alert`: what failed while it is open,
 *  drawn inside it (the page behind is out of reach and may be covered). `returnTo`: where the
 *  focus goes on closing when what opened the sheet is no longer in the page. `named`: the title is
 *  a name someone typed, isolated so that one written right to left keeps to itself. */
export function Sheet({
  title,
  onClose,
  children,
  hint,
  seeThrough = false,
  alert = null,
  returnTo,
  named = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  hint?: string;
  seeThrough?: boolean;
  alert?: string | null;
  returnTo?: () => HTMLElement | null;
  named?: boolean;
}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const hintId = useId();
  // Read as it opens, before anything in it takes the focus.
  const [opener] = useState(() => document.activeElement);
  const [fallback] = useState(() => returnTo);
  useLayoutEffect(() => {
    const shown = dialog.current!;
    shown.showModal();
    return () => {
      shown.close(); // or the page is still out of reach, the opener with it
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      else fallback?.()?.focus();
    };
  }, [opener, fallback]);

  return (
    <dialog
      ref={dialog}
      aria-label={title}
      aria-describedby={hint ? hintId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // The dialog covers the screen: a press on it, not on the sheet, is a press beside the sheet.
      // A touch screen has neither Escape nor a back gesture for a dialog.
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      // No blur behind it: costly on a phone, and a see-through sheet is judged on what is behind.
      className={clsx(
        "fixed inset-0 z-40 m-0 flex h-full max-h-none w-full max-w-none items-end justify-center border-0 p-0 text-parchment backdrop:bg-transparent md:pb-4",
        seeThrough ? "bg-transparent" : "bg-ink-950/60 animate-fade",
      )}
    >
      <div
        data-sheet
        className={clsx(
          "flex w-full flex-col overflow-hidden rounded-t-2xl pb-[env(safe-area-inset-bottom)] border border-b-0 border-ink-700 bg-ink-900 shadow-[0_-12px_40px_rgba(0,0,0,0.45)] animate-rise md:w-[28rem] md:rounded-2xl md:border-b",
          seeThrough ? "max-h-[60dvh]" : "max-h-[90dvh]",
        )}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 px-4 pt-3 sm:px-5">
          <div className="min-w-0 pt-2">
            {/* A title can be a name, whatever its owner typed: a handle is one long word. A long word
                is cut as its language cuts it (the page's lang), and anywhere only past that. */}
            <h2 className="break-words hyphens-auto font-display text-lg font-semibold">{named ? <bdi>{title}</bdi> : title}</h2>
            {hint && <p id={hintId} className="mt-0.5 text-xs text-mist">{hint}</p>}
          </div>
          <button
            onClick={onClose}
            className="-mr-2 shrink-0 rounded-lg p-3 text-mist transition-colors hover:bg-ink-700 hover:text-parchment md:p-1.5 md:mt-1.5 md:pointer-coarse:p-3 md:pointer-coarse:mt-0"
            aria-label={t("common.close")}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3 pb-4 sm:px-5">
          {children}
        </div>
        {/* Out of the scrolling, at the foot: in sight however far the body is scrolled. */}
        {alert && (
          <p role="alert" className="mx-4 mb-4 shrink-0 break-words rounded-lg border border-blood/40 bg-blood/10 px-3 py-2 text-sm text-blood sm:mx-5">
            {alert}
          </p>
        )}
      </div>
    </dialog>
  );
}

/** In a sheet, in place of what is on its way: a spinner, its rows drawn only once they can stay. */
export function SheetWait() {
  return (
    <div className="flex justify-center py-6" aria-busy="true">
      <Loader2 className="size-[20px] animate-spin text-mist" aria-hidden />
    </div>
  );
}
