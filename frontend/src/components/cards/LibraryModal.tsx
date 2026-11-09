import { LoadFailure } from "@/components/ui/LoadFailure";
import { Modal } from "@/components/ui/Modal";
import { Tag } from "@/components/ui/Tag";
import { data } from "@/data";
import { useT } from "@/i18n/useT";
import { cardToCharacter, installCard, type CardCharacter } from "@/lib/cards";
import { describeError } from "@/lib/errors";
import { BookMarked, Check, Download, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

interface Shelved {
  filename: string;
  has_avatar: boolean;
  character: CardCharacter;
  installed: boolean;
}

export function LibraryModal({
  onClose,
  onInstalled,
}: {
  onClose: () => void;
  onInstalled: () => void;
}) {
  const t = useT();
  const [items, setItems] = useState<Shelved[] | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);

  // What cannot be read is no empty library. A card counts as installed when one has its name.
  const load = () =>
    Promise.all([data.library.list(), data.characters.list()]).then(([shelf, characters]) => {
      const names = new Set(characters.map((c) => c.name));
      setItems(shelf.flatMap(({ filename, card, has_avatar }) => {
        const character = cardToCharacter(card);
        return character ? [{ filename, has_avatar, character, installed: names.has(character.name) }] : [];
      }));
      setFailure(null);
    }, (error) => setFailure({ error }));
  useEffect(() => {
    load();
  }, []);

  async function install(item: Shelved) {
    setInstalling(item.filename);
    setError(null);
    try {
      // The portrait first: one that cannot be had leaves nothing made.
      const portrait = item.has_avatar ? await data.file(data.library.avatarUrl(item.filename)) : null;
      await installCard(item.character, portrait);
      await load();
      onInstalled();
    } catch (e) {
      setError(describeError(e, t, t("cards.libraryModal.installError")));
    }
    setInstalling(null);
  }

  return (
    <Modal title={t("home.libraryTitle")} onClose={onClose} wide>
      <p className="mb-4 text-sm leading-relaxed text-mist">{t("cards.libraryModal.description")}</p>
      {failure ? (
        <LoadFailure error={failure.error} onRetry={load} />
      ) : items === null ? (
        <div className="py-8 text-center text-mist animate-pulse-soft">{t("common.loading")}</div>
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-mist-dim">
          {t("cards.libraryModal.emptyState")}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => (
            // On a phone the button drops to its own line and the artwork shrinks, so the words get the space.
            <div
              key={item.filename}
              className="flex flex-wrap items-start gap-3 rounded-xl border border-ink-700 bg-ink-900/60 p-3 sm:flex-nowrap sm:justify-between sm:gap-4 sm:p-4"
            >
              {item.has_avatar && (
                <img
                  src={data.library.avatarUrl(item.filename)}
                  alt={item.character.name}
                  className="h-[4.5rem] w-14 shrink-0 rounded-lg border border-ink-600 object-cover sm:h-24 sm:w-[4.5rem]"
                  draggable={false}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-display font-semibold">{item.character.name}</h3>
                  <Tag tone={item.character.kind === "scenario" ? "arcane" : "ember"}>
                    {item.character.kind === "scenario" ? t("chat.panel.kindScenario") : t("chat.panel.kindCharacter")}
                  </Tag>
                  {item.character.lore_entries.length > 0 && (
                    <Tag tone="arcane">
                      <span className="inline-flex items-center gap-1">
                        <BookMarked className="h-3 w-3" /> {t("cards.libraryModal.lorebookTag")}
                      </span>
                    </Tag>
                  )}
                </div>
                <p className="mt-1 text-sm italic leading-snug text-parchment-dim">
                  {item.character.tagline}
                </p>
                {item.character.tags.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {item.character.tags.map((tag) => (
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
