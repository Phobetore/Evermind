"use client";

import { TagInput } from "@/components/editor/TagInput";
import { useT } from "@/i18n/useT";
import { api } from "@/lib/api";
import type { LoreEntry, LoreEntryDraft } from "@/types";
import { BookMarked, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

/** Works in two modes:
 *  - saved character (`characterId` given): every change hits the API at once;
 *  - new character (no id): changes stay local, CharacterForm persists them
 *    right after creating the card. */
export function LorebookSection({
  characterId,
  entries,
  onChange,
}: {
  characterId?: string;
  entries: LoreEntryDraft[];
  onChange: (entries: LoreEntryDraft[]) => void;
}) {
  const t = useT();
  const [newKeys, setNewKeys] = useState<string[]>([]);
  const [newContent, setNewContent] = useState("");
  const [error, setError] = useState<string | null>(null);

  function flash(message: string) {
    setError(message);
    setTimeout(() => setError(null), 3000);
  }

  async function addEntry() {
    if (newKeys.length === 0 || !newContent.trim()) {
      flash(t("lorebook.entryRequiredError"));
      return;
    }
    const draft = {
      keys: newKeys,
      content: newContent.trim(),
      enabled: true,
      case_sensitive: false,
      priority: 0,
    };
    try {
      const saved = characterId
        ? await api.post<LoreEntry>(`/api/characters/${characterId}/lore`, draft)
        : { ...draft, id: crypto.randomUUID() };
      onChange([...entries, saved]);
      setNewKeys([]);
      setNewContent("");
    } catch (e) {
      flash(e instanceof Error ? e.message : t("lorebook.addFailedError"));
    }
  }

  async function patch(entry: LoreEntryDraft, changes: Partial<LoreEntryDraft>) {
    const updated = characterId
      ? await api.patch<LoreEntry>(`/api/lore/${entry.id}`, changes)
      : { ...entry, ...changes };
    onChange(entries.map((e) => (e.id === entry.id ? updated : e)));
  }

  async function remove(entry: LoreEntryDraft) {
    if (characterId) await api.delete(`/api/lore/${entry.id}`);
    onChange(entries.filter((e) => e.id !== entry.id));
  }

  return (
    <div className="rounded-xl border border-arcane-500/30 bg-arcane-glow/30 p-4">
      <div className="mb-1.5 flex items-center gap-2">
        <BookMarked className="h-4 w-4 text-arcane-300" />
        <span className="font-display text-sm font-semibold text-arcane-300">{t("lorebook.title")}</span>
      </div>
      <p className="mb-3 text-xs leading-relaxed text-mist">
        {t("lorebook.description")}
        {!characterId && t("lorebook.descriptionUnsavedSuffix")}
      </p>

      <div className="flex flex-col gap-2">
        {entries.map((entry) => (
          <div key={entry.id} className="rounded-lg border border-ink-700 bg-ink-900/60 p-3">
            <div className="mb-1.5 flex items-center justify-between gap-2">
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
              <div className="flex shrink-0 items-center gap-2">
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-mist">
                  <input
                    type="checkbox"
                    checked={entry.enabled}
                    onChange={() => patch(entry, { enabled: !entry.enabled })}
                    className="h-3.5 w-3.5 accent-[#8b66b3]"
                  />
                  {t("lorebook.enabledLabel")}
                </label>
                <button
                  type="button"
                  onClick={() => remove(entry)}
                  className="rounded p-1 text-mist-dim hover:bg-blood/15 hover:text-blood"
                  aria-label={t("lorebook.deleteEntryAriaLabel")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <textarea
              className="field min-h-16 text-sm"
              defaultValue={entry.content}
              onBlur={(e) => {
                const content = e.target.value.trim();
                if (content && content !== entry.content) patch(entry, { content });
              }}
            />
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
