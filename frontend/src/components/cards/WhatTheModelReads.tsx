import { ModelText } from "@/components/cards/ModelText";
import { PlainText } from "@/components/ui/PlainText";
import {
  DEFAULT_RP_RULES,
  ROLE_REMINDER,
  SCENARIO_RP_RULES,
  hasOriginalMacro,
  speakingName,
  substituteOriginal,
} from "@/engine";
import { useT } from "@/i18n/useT";
import { cardText } from "@/lib/utils";
import type { Character } from "@/types";
import { clsx } from "clsx";
import { useMemo, useState } from "react";

interface Shown {
  /** The key of the form's label for it, under characters.form. */
  label: string;
  text: string;
}

/** The fields of the definition as the model reads them, each with the form's name for it, those
 *  that read as nothing left out: the engine takes a field its markers leave blank for no field. */
function modelFields(character: Character, name: string, you: string): Shown[] {
  const rules = character.card_rules;
  const scenario = character.kind === "scenario";
  const read = (text: string) => cardText(text, rules, name, you);

  // As the engine builds its prompt: {{original}} in the card's prompt is Evermind's rules, then
  // the markers are read, {{char}} and {{user}} in those rules too.
  let prompt = character.system_prompt.trim();
  if (hasOriginalMacro(prompt)) prompt = substituteOriginal(prompt, scenario ? SCENARIO_RP_RULES : DEFAULT_RP_RULES);
  // On the card rules alone, the card's last instructions take the place of the reminder of who to
  // play, which {{original}} brings back; on the old ones the marker stays as written.
  let last = character.post_history_instructions.trim();
  if (rules === 2) last = substituteOriginal(last, ROLE_REMINDER);

  const fields: Shown[] = [
    { label: scenario ? "worldLabel" : "descriptionLabel", text: read(character.description) },
    { label: scenario ? "toneLabel" : "personalityLabel", text: read(character.personality) },
    { label: scenario ? "playerRoleLabel" : "startingSituationLabel", text: read(character.scenario) },
    { label: "exampleDialoguesLabel", text: read(character.example_dialogues) },
    { label: "systemPromptLabel", text: read(prompt) },
    { label: "postHistoryLabel", text: read(last) },
  ];
  return fields.filter((field) => field.text.trim() !== "");
}

/** What the model reads of the card, folded below the author's presentation, and drawn only once
 *  opened: a description of hundreds of kilobytes costs nothing until it is read. Laid out as
 *  Markdown alone, or as written at a tap, for this visit. Nothing when the card gives the model
 *  nothing of its own. */
export function WhatTheModelReads({ character, lore, you }: { character: Character; lore: number; you: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [asWritten, setAsWritten] = useState(false);
  const name = speakingName(character);
  // Once per card: the names are measured over each whole field.
  const fields = useMemo(() => modelFields(character, name, you), [character, name, you]);
  const note = useMemo(
    () => (character.card_rules === 2 ? cardText(character.character_note, 2, name, you) : ""),
    [character.card_rules, character.character_note, name, you],
  );
  const hasNote = note.trim() !== "";

  if (fields.length === 0 && !hasNote && lore === 0) return null;

  const depth = character.character_note_depth;
  const drawn = (text: string) =>
    asWritten ? (
      <PlainText text={text} className="text-sm leading-relaxed text-parchment-dim" />
    ) : (
      <ModelText text={text} className="text-sm leading-relaxed text-parchment-dim" />
    );

  return (
    <details className="mt-7" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="ui-label flex min-h-11 cursor-pointer items-center">{t("characters.detail.modelReads")}</summary>
      {open && (
        <div className="mt-2 flex flex-col gap-5">
          <p className="text-sm text-mist">{t("characters.detail.modelReadsHint")}</p>
          <div className="flex flex-wrap gap-2">
            {(
              [
                [false, "modelReadsLaidOut"],
                [true, "modelReadsAsWritten"],
              ] as const
            ).map(([written, key]) => (
              <button
                key={key}
                type="button"
                aria-pressed={asWritten === written}
                className={clsx("btn min-h-11", asWritten === written ? "btn-primary" : "btn-ghost")}
                onClick={() => setAsWritten(written)}
              >
                {t(`characters.detail.${key}`)}
              </button>
            ))}
          </div>
          {fields.map((field) => (
            <div key={field.label}>
              <h3 className="mb-1.5 font-display text-sm font-semibold text-parchment">
                {t(`characters.form.${field.label}`)}
              </h3>
              {drawn(field.text)}
            </div>
          ))}
          {hasNote && (
            <div>
              <h3 className="mb-1.5 font-display text-sm font-semibold text-parchment">
                {depth === 0
                  ? t("characters.detail.characterNoteAtEnd")
                  : t("characters.detail.characterNote", { count: depth })}
              </h3>
              {drawn(note)}
            </div>
          )}
          {lore > 0 && <p className="text-sm text-mist">{t("characters.detail.lore", { count: lore })}</p>}
        </div>
      )}
    </details>
  );
}
