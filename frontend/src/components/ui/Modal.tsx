import { useT } from "@/i18n/useT";
import { X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

/** The browser's own modal dialog: it holds the focus, puts the page out of reach, and gives the focus back. */
export function Modal({
  title,
  onClose,
  children,
  wide = false,
  role = "dialog",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  /** A question that must be answered before anything else is an alert dialog. */
  role?: "dialog" | "alertdialog";
}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  // Read as it opens, before anything in it takes the focus.
  const [opener] = useState(() => document.activeElement);
  useLayoutEffect(() => {
    const shown = dialog.current!;
    shown.showModal();
    return () => {
      shown.close(); // or the page is still out of reach, the opener with it
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [opener]);

  return (
    <dialog
      ref={dialog}
      // Its own role, written out as before: what finds a dialog by the attribute still does.
      role={role}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      className="fixed inset-0 z-40 m-0 flex h-full max-h-none w-full max-w-none items-center justify-center border-0 bg-ink-950/75 p-3 text-parchment backdrop-blur-sm animate-fade backdrop:bg-transparent sm:p-4"
    >
      <div
        className={`panel max-h-[92dvh] w-full sm:max-h-[88dvh] ${wide ? "max-w-2xl" : "max-w-md"} overflow-y-auto p-4 animate-rise sm:p-6`}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          {/* A title can be a name, whatever its owner typed: a handle is one long word. */}
          <h2 className="min-w-0 break-words text-xl font-semibold">{title}</h2>
          <button
            onClick={onClose}
            className="-mr-1 shrink-0 rounded-lg p-3 text-mist transition-colors hover:bg-ink-700 hover:text-parchment sm:mr-0 sm:p-1.5 sm:pointer-coarse:p-3"
            aria-label={t("common.close")}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
