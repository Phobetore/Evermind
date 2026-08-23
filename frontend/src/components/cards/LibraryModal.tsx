"use client";

import { Modal } from "@/components/ui/Modal";
import { Tag } from "@/components/ui/Tag";
import { useT } from "@/i18n/useT";
import { api } from "@/lib/api";
import type { LibraryItem } from "@/types";
import { BookMarked, Check, Download, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

export function LibraryModal({
  onClose,
  onInstalled,
}: {
  onClose: () => void;
  onInstalled: () => void;
}) {
  const t = useT();
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.get<LibraryItem[]>("/api/library").then(setItems);
  useEffect(() => {
    load().catch(() => setItems([]));
  }, []);

  async function install(item: LibraryItem) {
    setInstalling(item.filename);
    setError(null);
    try {
      await api.post(`/api/library/${item.filename}/install`);
      await load();
      onInstalled();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("cards.libraryModal.installError"));
    }
    setInstalling(null);
  }

  return (
    <Modal title={t("home.libraryTitle")} onClose={onClose} wide>
      <p className="mb-4 text-sm leading-relaxed text-mist">{t("cards.libraryModal.description")}</p>
      {items === null ? (
        <div className="py-8 text-center text-mist animate-pulse-soft">{t("common.loading")}</div>
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-mist-dim">
          {t("cards.libraryModal.emptyState")}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => (
            // Avatar, blurb and button held one row at every width. On a phone
            // that left the middle column nothing: the tagline came out as a
            // fifteen-line ribbon. The button now drops to its own full-width
            // line and the artwork shrinks, so the words get the space.
            <div
              key={item.filename}
              className="flex flex-wrap items-start gap-3 rounded-xl border border-ink-700 bg-ink-900/60 p-3 sm:flex-nowrap sm:justify-between sm:gap-4 sm:p-4"
            >
              {item.has_avatar && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/library/${item.filename}/avatar`}
                  alt={item.name}
                  className="h-[4.5rem] w-14 shrink-0 rounded-lg border border-ink-600 object-cover sm:h-24 sm:w-[4.5rem]"
                  draggable={false}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-display font-semibold">{item.name}</h3>
                  <Tag tone={item.kind === "scenario" ? "arcane" : "ember"}>
                    {item.kind === "scenario" ? t("chat.panel.kindScenario") : t("chat.panel.kindCharacter")}
                  </Tag>
                  {item.has_lorebook && (
                    <Tag tone="arcane">
                      <span className="inline-flex items-center gap-1">
                        <BookMarked className="h-3 w-3" /> {t("cards.libraryModal.lorebookTag")}
                      </span>
                    </Tag>
                  )}
                </div>
                <p className="mt-1 text-sm italic leading-snug text-parchment-dim">
                  {item.tagline}
                </p>
                {item.tags.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {item.tags.map((tag) => (
                      <Tag key={tag}>{tag}</Tag>
                    ))}
                  </div>
                )}
              </div>
              {item.installed ? (
                <span className="flex w-full shrink-0 items-center justify-center gap-1.5 text-sm text-moss sm:w-auto sm:justify-start">
                  <Check className="h-4 w-4" /> {t("cards.libraryModal.installedLabel")}
                </span>
              ) : (
                <button
                  className="btn btn-primary w-full shrink-0 text-sm sm:w-auto sm:!py-2"
                  onClick={() => install(item)}
                  disabled={installing !== null}
                >
                  {installing === item.filename ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  {t("cards.libraryModal.installButton")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {error && (
        <p className="mt-3 rounded-lg border border-blood/40 bg-blood/10 px-4 py-2.5 text-sm text-blood">
          {error}
        </p>
      )}
    </Modal>
  );
}
