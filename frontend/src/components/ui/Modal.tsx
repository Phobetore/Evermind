"use client";

import { useT } from "@/i18n/useT";
import { X } from "lucide-react";
import { useEffect } from "react";

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink-950/75 p-3 backdrop-blur-sm animate-fade sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={`panel max-h-[92dvh] w-full sm:max-h-[88dvh] ${wide ? "max-w-2xl" : "max-w-md"} overflow-y-auto p-4 animate-rise sm:p-6`}
        role="dialog"
        aria-label={title}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-xl font-semibold">{title}</h2>
          <button
            onClick={onClose}
            className="-mr-1 shrink-0 rounded-lg p-2.5 text-mist transition-colors hover:bg-ink-700 hover:text-parchment sm:mr-0 sm:p-1.5"
            aria-label={t("common.close")}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
