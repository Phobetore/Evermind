"use client";

import { CharacterCard } from "@/components/cards/CharacterCard";
import { LibraryModal } from "@/components/cards/LibraryModal";
import { EmptyState } from "@/components/ui/EmptyState";
import { useT } from "@/i18n/useT";
import { api } from "@/lib/api";
import type { Character, Kind } from "@/types";
import { clsx } from "clsx";
import { FileUp, LibraryBig, Plus, Search, Sparkles, Star } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

const TABS: { value: Kind | "all"; labelKey: string }[] = [
  { value: "all", labelKey: "home.tabs.all" },
  { value: "character", labelKey: "home.tabs.characters" },
  { value: "scenario", labelKey: "home.tabs.scenarios" },
];

export default function HubPage() {
  const t = useT();
  const [characters, setCharacters] = useState<Character[] | null>(null);
  const [tab, setTab] = useState<Kind | "all">("all");
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async (kind: Kind | "all", q: string) => {
    const params = new URLSearchParams();
    if (kind !== "all") params.set("kind", kind);
    if (q.trim()) params.set("q", q.trim());
    try {
      setCharacters(await api.get<Character[]>(`/api/characters?${params}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("home.loadError"));
    }
  }, [t]);

  useEffect(() => {
    const t = setTimeout(() => load(tab, query), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [tab, query, load]);

  async function handleImport(file: File) {
    try {
      await api.upload<Character>("/api/characters/import", file);
      await load(tab, query);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("home.importError"));
    }
  }

  async function toggleFavorite(character: Character) {
    const updated = await api.put<Character>(`/api/characters/${character.id}`, {
      is_favorite: !character.is_favorite,
    });
    setCharacters((prev) =>
      prev ? prev.map((c) => (c.id === character.id ? updated : c)) : prev,
    );
  }

  const allTags = [...new Set((characters ?? []).flatMap((c) => c.tags))].slice(0, 12);
  let shown = activeTag
    ? (characters ?? []).filter((c) => c.tags.includes(activeTag))
    : characters;
  if (shown && favoritesOnly) shown = shown.filter((c) => c.is_favorite);

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 lg:px-10">
      {/* Hero */}
      <header className="mb-8 animate-rise">
        <h1 className="font-display text-4xl font-semibold tracking-tight lg:text-[2.75rem]">
          {t("home.hero.title")}<span className="text-ember-400">.</span>
        </h1>
        <p className="mt-2 max-w-xl text-mist">{t("home.hero.subtitle")}</p>
      </header>

      {/* Toolbar */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="flex rounded-xl border border-ink-700 bg-ink-900 p-1">
          {TABS.map(({ value, labelKey }) => (
            <button
              key={value}
              onClick={() => setTab(value)}
              className={clsx(
                "rounded-lg px-4 py-1.5 font-display text-sm font-medium transition-colors",
                tab === value
                  ? "bg-ink-700 text-parchment shadow-sm"
                  : "text-mist hover:text-parchment",
              )}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>

        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mist-dim" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("home.searchPlaceholder")}
            className="field pl-9"
          />
        </div>

        <button
          className={clsx(
            "btn",
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
          className="btn btn-ghost"
          onClick={() => setShowLibrary(true)}
          title={t("home.libraryTitle")}
        >
          <LibraryBig className="h-4 w-4" />
          <span className="hidden sm:inline">{t("home.library")}</span>
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => fileInput.current?.click()}
          title={t("home.importTitle")}
        >
          <FileUp className="h-4 w-4" />
          <span className="hidden sm:inline">{t("home.import")}</span>
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,.png"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleImport(f);
            e.target.value = "";
          }}
        />
        <Link href="/characters/new" className="btn btn-primary">
          <Plus className="h-4 w-4" />
          {t("home.create")}
        </Link>
      </div>

      {/* Tag rail */}
      {allTags.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-2">
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => setActiveTag(activeTag === tag ? null : tag)}
              className={clsx(
                "rounded-full border px-3 py-1 font-display text-xs font-medium transition-colors",
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

      {error && (
        <p className="mb-4 rounded-lg border border-blood/40 bg-blood/10 px-4 py-2.5 text-sm text-blood">
          {error}
        </p>
      )}

      {/* Grid */}
      {shown === null ? (
        <div className="grid grid-cols-2 gap-5 md:grid-cols-3 xl:grid-cols-4">
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
        <div className="stagger grid grid-cols-2 gap-5 md:grid-cols-3 xl:grid-cols-4">
          {shown.map((character) => (
            <CharacterCard
              key={character.id}
              character={character}
              onToggleFavorite={toggleFavorite}
            />
          ))}
        </div>
      )}

      {showLibrary && (
        <LibraryModal
          onClose={() => setShowLibrary(false)}
          onInstalled={() => load(tab, query)}
        />
      )}
    </div>
  );
}
