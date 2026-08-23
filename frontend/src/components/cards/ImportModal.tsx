"use client";

import { Modal } from "@/components/ui/Modal";
import { useT } from "@/i18n/useT";
import { api } from "@/lib/api";
import type { Character } from "@/types";
import { Check, FileUp, Loader2, X } from "lucide-react";
import { useRef, useState } from "react";

interface Result {
  name: string;
  error?: string;
}

/** Clicking Import used to open the system file picker straight away, which
 *  asks people to already know what Evermind takes. This says so first, and
 *  takes a file either by drop or by click. */
export function ImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[]>([]);

  async function importFiles(files: File[]) {
    if (!files.length || busy) return;
    setBusy(true);
    setResults([]);
    const done: Result[] = [];
    // One at a time: the endpoint takes a single card, and a failure part way
    // through should not cost the ones that already worked.
    for (const file of files) {
      try {
        await api.upload<Character>("/api/characters/import", file);
        done.push({ name: file.name });
      } catch (e) {
        done.push({
          name: file.name,
          error: e instanceof Error ? e.message : t("home.importError"),
        });
      }
      setResults([...done]);
    }
    setBusy(false);
    if (done.some((r) => !r.error)) onImported();
  }

  return (
    <Modal title={t("home.importModal.title")} onClose={onClose}>
      <p className="text-sm leading-relaxed text-mist">
        {t("home.importModal.intro")}
      </p>

      <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-mist marker:text-ember-600/70">
        <li>{t("home.importModal.acceptsPng")}</li>
        <li>{t("home.importModal.acceptsJson")}</li>
        <li>{t("home.importModal.acceptsLorebook")}</li>
      </ul>

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          importFiles([...e.dataTransfer.files]);
        }}
        disabled={busy}
        className={[
          "mt-4 flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed",
          "px-6 py-8 text-center transition-colors",
          dragging
            ? "border-ember-500 bg-ember-glow text-parchment"
            : "border-ink-600 text-mist hover:border-ember-600/60 hover:text-parchment",
        ].join(" ")}
      >
        {busy ? (
          <Loader2 className="h-6 w-6 animate-spin" />
        ) : (
          <FileUp className="h-6 w-6" />
        )}
        <span className="text-sm font-semibold">{t("home.importModal.dropTitle")}</span>
        <span className="text-xs text-mist-dim">{t("home.importModal.dropHint")}</span>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept=".json,.png,application/json,image/png"
        multiple
        className="hidden"
        onChange={(e) => {
          importFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />

      {results.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2">
          {results.map((r) => (
            <li key={r.name} className="flex items-start gap-2 text-sm">
              {r.error ? (
                <X className="mt-0.5 h-4 w-4 shrink-0 text-blood" />
              ) : (
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-moss" />
              )}
              <span className="min-w-0">
                <span className="break-all text-parchment-dim">{r.name}</span>
                {r.error && <span className="block text-blood">{r.error}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-xs leading-relaxed text-mist-dim">
        {t("home.importModal.sizeNote")}
      </p>
    </Modal>
  );
}
