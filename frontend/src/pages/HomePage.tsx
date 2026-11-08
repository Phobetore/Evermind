import { CharacterCard } from "@/components/cards/CharacterCard";
import { ImportModal } from "@/components/cards/ImportModal";
import { LibraryModal } from "@/components/cards/LibraryModal";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { data } from "@/data";
import { useT } from "@/i18n/useT";
import { describeError } from "@/lib/errors";
import type { Character, Kind } from "@/types";
import { clsx } from "clsx";
import { FileUp, LibraryBig, Plus, Search, Sparkles, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";

/** These three lose their labels on a phone, and their side padding: at 53px each, Create would not fit at 320px. */
const SQUARE_ON_PHONE = "max-sm:w-11 max-sm:!px-0";

const TABS: { value: Kind | "all"; labelKey: string }[] = [
  { value: "all", labelKey: "home.tabs.all" },
  { value: "character", labelKey: "home.tabs.characters" },
  { value: "scenario", labelKey: "home.tabs.scenarios" },
];

export function HomePage() {
  const t = useT();
  const [characters, setCharacters] = useState<Character[] | null>(null);
  const [tab, setTab] = useState<Kind | "all">("all");
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  // Said on the card whose star did not go through, until the next star.
  const [favoriteFailure, setFavoriteFailure] = useState<{ id: string; error: unknown } | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const load = () =>
    data.characters.list().then((list) => {
      setCharacters(list);
      setFailure(null);
    }, (error) => setFailure({ error }));
  useEffect(() => {
    load();
  }, []);

  const replace = (updated: Character) =>
    setCharacters((prev) => (prev ? prev.map((c) => (c.id === updated.id ? updated : c)) : prev));

  async function toggleFavorite(character: Character) {
    setFavoriteFailure(null);
    try {
      replace(await data.characters.update(character.id, { is_favorite: !character.is_favorite }));
    } catch (error) {
      setFavoriteFailure({ id: character.id, error });
      // It may have gone through all the same: the star shows what the server holds.
      data.characters.get(character.id).then(replace, () => {});
    }
  }

  const words = query.trim().toLowerCase();
  const found = (characters ?? []).filter((c) => (tab === "all" || c.kind === tab)
    && [c.name, c.tagline, c.description].some((text) => text.toLowerCase().includes(words)));
  const allTags = [...new Set(found.flatMap((c) => c.tags))].slice(0, 12);
  const shown = characters && found.filter((c) =>
    (!activeTag || c.tags.includes(activeTag)) && (!favoritesOnly || c.is_favorite));

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10 lg:px-10">
      <header className="mb-6 animate-rise sm:mb-8">
        <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl lg:text-[2.75rem]">
          {t("home.hero.title")}<span className="text-ember-400">.</span>
        </h1>
        <p className="mt-2 max-w-xl text-mist">{t("home.hero.subtitle")}</p>
      </header>

      {/* One wrapping row where there is room; below sm, three: tabs, search, then the actions. */}
      <div className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex rounded-xl border border-ink-700 bg-ink-900 p-1">
          {TABS.map(({ value, labelKey }) => (
            <button
              key={value}
              onClick={() => setTab(value)}
              className={clsx(
                "flex-1 rounded-lg px-4 py-3 font-display text-sm font-medium transition-colors sm:flex-none sm:py-1.5",
                tab === value
                  ? "bg-ink-700 text-parchment shadow-sm"
                  : "text-mist hover:text-parchment",
              )}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>

        {/* A floor over 192px pushes Create onto a line of its own at 1280px. */}
        <div className="relative sm:min-w-48 sm:flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mist-dim" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("home.searchPlaceholder")}
            className="field pl-9"
          />
        </div>

        {/* display:contents from sm up, so the four actions go back to being
            direct children of the wrapping row on wider screens. */}
        <div className="flex gap-3 sm:contents">
          <button
            className={clsx(
              "btn " + SQUARE_ON_PHONE,
              favoritesOnly
                ? "border border-ember-500/60 bg-ember-glow text-ember-300"
                : "btn-ghost",
            )}
            onClick={() => setFavoritesOnly(!favoritesOnly)}
            title={t("home.favoritesOnlyTitle")}
          >
            <Star className={clsx("h-4 w-4", favoritesOnly && "fill-current")} />
            <span className="hidden sm:inline">{t("home.favorites")}</span>
          </button>
          <button
            className={"btn btn-ghost " + SQUARE_ON_PHONE}
            onClick={() => setShowLibrary(true)}
            title={t("home.libraryTitle")}
          >
            <LibraryBig className="h-4 w-4" />
            <span className="hidden sm:inline">{t("home.library")}</span>
          </button>
          <button
            className={"btn btn-ghost " + SQUARE_ON_PHONE}
            onClick={() => setImportOpen(true)}
            title={t("home.importTitle")}
          >
            <FileUp className="h-4 w-4" />
            <span className="hidden sm:inline">{t("home.import")}</span>
          </button>
          <Link to="/characters/new" className="btn btn-primary flex-1 sm:flex-none">
            <Plus className="h-4 w-4" />
            {t("home.create")}
          </Link>
        </div>
      </div>

      {/* On a touch screen a chip answers 7px beyond what is drawn: the rail has that much padding, which
          its scrolling would clip otherwise, and wrapped rows are far enough apart for those areas not to meet. */}
      {allTags.length > 0 && (
        <div className="-mx-4 mb-5 flex gap-2 overflow-x-auto px-4 pb-1 pointer-coarse:gap-y-5 pointer-coarse:py-2 sm:mx-0 sm:mb-6 sm:flex-wrap sm:overflow-x-visible sm:px-0 sm:pb-0">
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => setActiveTag(activeTag === tag ? null : tag)}
              className={clsx(
                "touch-target shrink-0 rounded-full border px-3 py-1.5 font-display text-xs font-medium transition-colors sm:py-1",
                activeTag === tag
                  ? "border-ember-500 bg-ember-glow text-ember-300"
                  : "border-ink-600 text-mist hover:border-ink-500 hover:text-parchment",
              )}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {failure ? (
        <LoadFailure error={failure.error} onRetry={load} />
      ) : shown === null ? (
        <div className="grid grid-cols-2 gap-3 sm:gap-5 md:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="aspect-[3/4] animate-pulse-soft rounded-2xl bg-ink-850" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <EmptyState icon={Sparkles} title={t("home.emptyState.title")}>
          <span className="block">
            {t("home.emptyState.before")}{" "}
            <button className="font-semibold text-ember-300 underline-offset-2 hover:underline" onClick={() => setShowLibrary(true)}>
              {t("home.emptyState.libraryLink")}
            </button>
            {t("home.emptyState.after")}
          </span>
        </EmptyState>
      ) : (
        <div className="stagger grid grid-cols-2 gap-3 sm:gap-5 md:grid-cols-3 xl:grid-cols-4">
          {shown.map((character) => (
            <CharacterCard
              key={character.id}
              character={character}
              onToggleFavorite={toggleFavorite}
              error={favoriteFailure?.id === character.id ? describeError(favoriteFailure.error, t) : undefined}
            />
          ))}
        </div>
      )}

      {showLibrary && (
        <LibraryModal
          onClose={() => setShowLibrary(false)}
          onInstalled={load}
        />
      )}

      {importOpen && (
        <ImportModal
          onClose={() => setImportOpen(false)}
          onImported={load}
        />
      )}
    </div>
  );
}
