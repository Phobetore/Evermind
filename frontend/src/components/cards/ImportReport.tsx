import { data } from "@/data";
import { useT } from "@/i18n/useT";
import { describeError } from "@/lib/errors";
import type { ReadCard, ReportLine } from "@/lib/cards";
import type { Character } from "@/types";
import { clsx } from "clsx";
import { BookOpenText, Check, UserRound } from "lucide-react";
import { useState } from "react";
import { unreadLabels } from "./unreadLabels";

/** The names of `unreadFields` that say something of their own: a name, or a nickname, that was
 *  cut. They get a sentence each, apart from the fields that held something that is no text. */
const CUT_SENTENCES: Record<string, string> = { "name.cut": "nameCut", "nickname.cut": "nicknameCut" };

interface Sentence { key: string; line: ReportLine }

/** The lines as sentences: an `unreadFields` line holding cut names is said as one line for the
 *  fields and one for each cut. */
function sentences(lines: ReportLine[]): Sentence[] {
  return lines.flatMap((line): Sentence[] => {
    if (line.key !== "unreadFields") return [{ key: line.key, line }];
    const names = line.names ?? [];
    const plain = names.filter((name) => !(name in CUT_SENTENCES));
    return [
      ...(plain.length > 0 ? [{ key: "unreadFields", line: { ...line, names: plain } }] : []),
      ...names.filter((name) => name in CUT_SENTENCES)
        .map((name) => ({ key: CUT_SENTENCES[name], line: { ...line, names: undefined } })),
    ];
  });
}

/** What an import understood of a card, and the two questions it leaves with the person: what the
 *  card is, and its tagline. Nothing is written until the person saves. */
export function ImportReport({
  character,
  read,
  onSaved,
}: {
  character: Character;
  read: ReadCard;
  onSaved: (c: Character) => void;
}) {
  const t = useT();
  const [kind, setKind] = useState(character.kind);
  // Offered, never written by itself: a card with a tagline of its own keeps it.
  const [tagline, setTagline] = useState(character.tagline || read.suggestedTagline);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const say = ({ key, line }: Sentence) => {
    // The places of a card are said as the form names them, not by their paths in the file.
    const names = key === "unreadFields" ? unreadLabels(line.names ?? [], read.character, t) : line.names ?? [];
    return <li key={key}>{t(`cards.report.${key}`, { count: line.count ?? 0, names: names.join(", ") })}</li>;
  };
  const used = sentences(read.report.used);
  const kept = sentences(read.report.kept);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      onSaved(await data.characters.update(character.id, { kind, tagline }));
      setSaved(true);
    } catch (e) {
      setError(describeError(e, t, t("cards.report.saveError")));
    }
    setSaving(false);
  }

  return (
    // One report per file imported: its name tells a screen reader which card these buttons save.
    <div role="group" aria-label={character.name} className="mt-2 flex flex-col gap-3 text-xs leading-relaxed text-mist">
      {used.length > 0 && (
        <div>
          <p className="font-semibold text-parchment-dim">{t("cards.report.used")}</p>
          <ul className="mt-1 list-disc pl-4 marker:text-ember-600/70">{used.map(say)}</ul>
        </div>
      )}

      {(kept.length > 0 || read.report.newer) && (
        <details>
          <summary className="cursor-pointer font-semibold text-parchment-dim">
            {t("cards.report.kept")}
          </summary>
          {read.report.newer && <p className="mt-1">{t("cards.report.newer")}</p>}
          {kept.length > 0 && (
            <ul className="mt-1 list-disc pl-4 marker:text-ember-600/70">{kept.map(say)}</ul>
          )}
        </details>
      )}

      <div className="flex flex-col gap-2">
        <p className="font-semibold text-parchment-dim">{t("cards.report.kindQuestion")}</p>
        <div className="flex gap-2">
          {(
            [
              { value: "character", labelKey: "chat.panel.kindCharacter", icon: UserRound },
              { value: "scenario", labelKey: "chat.panel.kindScenario", icon: BookOpenText },
            ] as const
          ).map(({ value, labelKey, icon: Icon }) => (
            <button
              key={value}
              type="button"
              aria-pressed={kind === value}
              // Locked while a save is in flight, so "Saved" never sits next to other values.
              disabled={saving}
              onClick={() => {
                setKind(value);
                setSaved(false);
              }}
              className={clsx(
                "flex flex-1 items-center justify-center gap-2 rounded-xl border py-2 text-sm font-medium transition-colors",
                kind === value
                  ? value === "scenario"
                    ? "border-arcane-500/60 bg-arcane-glow text-arcane-300"
                    : "border-ember-500/60 bg-ember-glow text-ember-300"
                  : "border-ink-700 text-mist hover:border-ink-500",
              )}
            >
              <Icon className="h-4 w-4" /> {t(labelKey)}
            </button>
          ))}
        </div>

        <label className="flex flex-col gap-1">
          <span className="font-semibold text-parchment-dim">{t("cards.report.taglineQuestion")}</span>
          <input
            className="field"
            value={tagline}
            disabled={saving}
            onChange={(e) => {
              setTagline(e.target.value);
              setSaved(false);
            }}
          />
        </label>

        <div className="flex items-center gap-3">
          <button type="button" className="btn btn-ghost !px-3 !py-1.5 text-xs" disabled={saving} onClick={save}>
            {t("cards.report.save")}
          </button>
          {saved && (
            <span role="status" className="flex items-center gap-1 text-moss">
              <Check className="h-3.5 w-3.5" /> {t("cards.report.saved")}
            </span>
          )}
          {error && <span role="alert" className="text-blood">{error}</span>}
        </div>
      </div>
    </div>
  );
}
