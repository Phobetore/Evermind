import { Presentation } from "@/components/cards/Presentation";
import { Folded } from "@/components/ui/Folded";
import { speakingName } from "@/engine";
import { useI18n } from "@/i18n/I18nProvider";
import { chosenNotes, isLanguageTag, languageName, notesVersions } from "@/lib/presentation/notes";
import { previewMacros } from "@/lib/utils";
import type { Character } from "@/types";
import { useId, useMemo, useState } from "react";

/** The author's presentation, in the interface's language when the card has it, another to be
 *  chosen in one control. A region of its own, named: a screen reader says where it starts and
 *  ends, and the card's headings are listed in it, apart from the page's. Nothing without one. */
export function CharacterNotes({ character, you }: { character: Character; you: string }) {
  const { t, locale } = useI18n();
  const id = useId();
  const { creator_notes, creator_notes_multilingual } = character;
  // Read again only when these change: the page draws again without the card changing, and the
  // pass over the keys follows the size of the card.
  const versions = useMemo(
    () => notesVersions({ creator_notes, creator_notes_multilingual }),
    [creator_notes, creator_notes_multilingual],
  );
  const labels = useMemo(
    () =>
      versions.map((version, index) => {
        if (version.lang === null) return t("characters.detail.notesMain");
        if (isLanguageTag(version.lang)) return languageName(version.lang, locale);
        // A key of another form is never shown: it could read as anything, a button's name too.
        return t("characters.detail.notesOther", { index: index + 1 });
      }),
    [versions, locale, t],
  );
  // The choice holds for this visit, and starts again from the interface's language.
  const [chosen, setChosen] = useState<{ versions: typeof versions; index: number } | null>(null);
  const index = chosen && chosen.versions === versions ? chosen.index : chosenNotes(versions, locale);
  const version = index >= 0 ? versions[index] : null;
  const name = speakingName(character);
  // Read once per text: the names are measured over the whole of it, and a presentation of
  // megabytes would cost seconds on a phone on every draw of the page.
  const shown = useMemo(() => (version ? previewMacros(version.text, name, you) : ""), [version, name, you]);

  if (!version) return null;
  return (
    <section aria-labelledby={id} className="mt-7">
      <h2 id={id} className="ui-label mb-2">
        {t("characters.detail.fromTheAuthor")}
      </h2>
      {versions.length > 1 && (
        <select
          className="field mb-3 min-h-11 w-full sm:w-auto"
          aria-label={t("characters.detail.notesLanguage")}
          value={index}
          onChange={(event) => setChosen({ versions, index: Number(event.target.value) })}
        >
          {labels.map((label, i) => (
            <option key={i} value={i}>
              {label}
            </option>
          ))}
        </select>
      )}
      <Folded>
        <Presentation text={shown} />
      </Folded>
      <p className="mt-2 text-xs text-mist-dim">{t("characters.detail.notReadByModel")}</p>
    </section>
  );
}
