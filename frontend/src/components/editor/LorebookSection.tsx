import { LoreEntrySettings } from "@/components/editor/LoreEntrySettings";
import { TagInput } from "@/components/editor/TagInput";
import { useT } from "@/i18n/useT";
import { newLoreEntry } from "@/lib/loreEntry";
import { newId } from "@/lib/utils";
import type { LoreEntry } from "@/types";
import { BookMarked, ChevronDown, Plus, Trash2 } from "lucide-react";
import { clsx } from "clsx";
import { useState } from "react";

/** The lorebook as it will be saved, with the rest of the card. */
export function LorebookSection({
  entries,
  onChange,
  rules,
}: {
  entries: LoreEntry[];
  onChange: (entries: LoreEntry[]) => void;
  /** The rules of the card: the title and the settings of an entry are shown on the second only,
   *  the only ones that read them. The first sends back what it was given. */
  rules: 1 | 2;
}) {
  const t = useT();
  // The entries whose settings are open. Not saved: opening is only looking.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [newKeys, setNewKeys] = useState<string[]>([]);
  const [newContent, setNewContent] = useState("");
  const [error, setError] = useState<string | null>(null);

  function addEntry() {
    if (newKeys.length === 0 || !newContent.trim()) {
      setError(t("lorebook.entryRequiredError"));
      return;
    }
    onChange([...entries, { ...newLoreEntry(newKeys, newContent.trim()), id: newId() }]);
    setNewKeys([]);
    setNewContent("");
    setError(null);
  }

  const toggle = (id: string) =>
    setOpen((was) => {
      const now = new Set(was);
      if (!now.delete(id)) now.add(id);
      return now;
    });

  // Every entry has its "Settings": a screen reader is told whose, by the entry's title, else its
  // first key, else its number.
  const settingsName = (entry: LoreEntry, i: number) => t("lorebook.settingsFor", {
    name: entry.comment.trim() || entry.keys[0] || t("lorebook.entryNumber", { number: i + 1 }),
  });

  const change = (entry: LoreEntry, changes: Partial<LoreEntry>) =>
    onChange(entries.map((e) => (e.id === entry.id ? { ...e, ...changes } : e)));

  return (
    <div className="rounded-xl border border-arcane-500/30 bg-arcane-glow/30 p-4">
      <div className="mb-1.5 flex items-center gap-2">
        <BookMarked className="h-4 w-4 text-arcane-300" />
        <span className="font-display text-sm font-semibold text-arcane-300">{t("lorebook.title")}</span>
      </div>
      <p className="mb-3 text-xs leading-relaxed text-mist">
        {t("lorebook.description")}
        {t("lorebook.descriptionUnsavedSuffix")}
      </p>

      <div className="flex flex-col gap-2">
        {entries.map((entry, i) => (
          <div key={entry.id} className="rounded-lg border border-ink-700 bg-ink-900/60 p-3">
            {rules === 2 && (
              <input
                className="field mb-2 text-sm pointer-coarse:mb-3"
                value={entry.comment}
                onChange={(e) => change(entry, { comment: e.target.value })}
                placeholder={t("lorebook.titlePlaceholder")}
                aria-label={t("lorebook.titleLabel")}
              />
            )}
            {/* Further from the text boxes above and below on a touch screen: the reachable
                area of the delete button is 44px, and must not be over them. */}
            <div className="mb-1.5 flex items-center justify-between gap-2 pointer-coarse:mb-3">
              <div className="flex flex-wrap gap-1.5">
                {entry.keys.map((k) => (
                  <span
                    key={k}
                    className="rounded-full border border-arcane-500/40 px-2 py-0.5 font-mono text-[0.68rem] text-arcane-300"
                  >
                    {k}
                  </span>
                ))}
              </div>
              <div className="flex shrink-0 items-center gap-2 pointer-coarse:gap-3">
                <label className="touch-target flex cursor-pointer items-center gap-1.5 text-xs text-mist">
                  <input
                    type="checkbox"
                    checked={entry.enabled}
                    onChange={() => change(entry, { enabled: !entry.enabled })}
                    className="h-3.5 w-3.5 accent-[#8b66b3]"
                  />
                  {t("lorebook.enabledLabel")}
                </label>
                <button
                  type="button"
                  onClick={() => onChange(entries.filter((e) => e.id !== entry.id))}
                  className="touch-target rounded p-1 text-mist-dim hover:bg-blood/15 hover:text-blood"
                  aria-label={t("lorebook.deleteEntryAriaLabel")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <textarea
              className="field min-h-16 text-sm"
              value={entry.content}
              onChange={(e) => change(entry, { content: e.target.value })}
            />
            {rules === 2 && (
              <>
                <button
                  type="button"
                  onClick={() => toggle(entry.id)}
                  aria-expanded={open.has(entry.id)}
                  aria-controls={`lore-settings-${entry.id}`}
                  aria-label={settingsName(entry, i)}
                  className="mt-2 flex items-center gap-1.5 font-display text-xs font-medium pointer-coarse:min-h-11 text-mist transition-colors hover:text-parchment"
                >
                  <ChevronDown className={clsx("h-3.5 w-3.5 transition-transform", open.has(entry.id) && "rotate-180")} />
                  {t("lorebook.settingsButton")}
                </button>
                {open.has(entry.id) && (
                  <LoreEntrySettings
                    entry={entry}
                    id={`lore-settings-${entry.id}`}
                    label={settingsName(entry, i)}
                    onChange={(changes) => change(entry, changes)}
                  />
                )}
              </>
            )}
          </div>
        ))}
        {entries.length === 0 && (
          <p className="text-xs italic text-mist-dim">{t("lorebook.emptyState")}</p>
        )}
      </div>

      <div className="mt-3 flex flex-col gap-2 rounded-lg border border-dashed border-ink-600 p-3">
        <TagInput
          value={newKeys}
          onChange={setNewKeys}
          placeholder={t("lorebook.keysPlaceholder")}
        />
        <textarea
          className="field min-h-16 text-sm"
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          placeholder={t("lorebook.contentPlaceholder")}
        />
        <button type="button" className="btn btn-ghost self-end !py-1.5 text-xs" onClick={addEntry}>
          <Plus className="h-3.5 w-3.5" /> {t("lorebook.addEntryButton")}
        </button>
        {error && <p className="text-xs text-blood">{error}</p>}
      </div>
    </div>
  );
}
