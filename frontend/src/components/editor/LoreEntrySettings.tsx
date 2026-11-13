import { Field } from "@/components/editor/Field";
import { TagInput } from "@/components/editor/TagInput";
import { useT } from "@/i18n/useT";
import type { LoreEntry, NoteRole } from "@/types";
import { useState } from "react";

/** The largest whole number JSON and JavaScript both hold exactly: the server's bound too. */
const WHOLE = Number.MAX_SAFE_INTEGER;

/** The places Evermind lets a person choose; the others SillyTavern has are shown as they are read. */
const CHOSEN_PLACES = [0, 1, 4];

export const ROLES: NoteRole[] = ["system", "user", "assistant"];

/**
 * A whole number typed in a box. What is typed is kept as typed until it is a number the card can
 * hold: a half-typed "-" or an emptied box must not be turned into 0 under the person's fingers.
 * Leaving the box shows the number that is saved.
 */
export function NumberField({
  value, min = 0, onChange,
}: {
  value: number;
  min?: number;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  // The value can change from outside (a save, another place chosen): the box follows it, unless
  // what is typed already is that number. Adjusted while rendering, as React asks for a value
  // derived from a prop.
  const [followed, setFollowed] = useState(value);
  if (followed !== value) {
    setFollowed(value);
    if (!/^-?\d+$/.test(text) || Number(text) !== value) setText(String(value));
  }

  return (
    <input
      type="number"
      step={1}
      min={min}
      className="field"
      value={text}
      onChange={(e) => {
        const typed = e.target.value;
        setText(typed);
        const n = Number(typed);
        if (/^-?\d+$/.test(typed) && Number.isSafeInteger(n) && n >= min && n <= WHOLE) onChange(n);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

/** A switch: the row is as high as a thumb needs on a touch screen, and the whole row answers. */
function Switch({
  label, checked, onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-parchment-dim pointer-coarse:min-h-11">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 shrink-0 accent-[#8b66b3]"
      />
      {label}
    </label>
  );
}

/** What the card says of one lorebook entry beyond its keys and its text: when it applies, and
 *  where it is put. Every change goes up as the fields it changes; the rest of the entry is
 *  the caller's, and stays as it was read. */
export function LoreEntrySettings({
  entry, onChange,
}: {
  entry: LoreEntry;
  onChange: (changes: Partial<LoreEntry>) => void;
}) {
  const t = useT();
  const place = entry.position;
  // A place the form has no choice for stays on offer while it is the entry's, so that
  // the select shows what the card says and a save sends it back as it came.
  const unchosen = !CHOSEN_PLACES.includes(place);

  return (
    <div
      role="group"
      aria-label={t("lorebook.settingsButton")}
      className="mt-3 flex flex-col gap-4 rounded-md border border-ink-700 bg-ink-850/60 p-3 animate-fade"
    >
      <Switch
        label={t("lorebook.constantLabel")}
        checked={entry.constant}
        onChange={(constant) => onChange({ constant })}
      />

      <div className="flex flex-col gap-2">
        <span className="ui-label">{t("lorebook.secondaryKeysLabel")}</span>
        <TagInput
          value={entry.secondary_keys}
          onChange={(secondary_keys) => onChange({ secondary_keys })}
          placeholder={t("lorebook.secondaryKeysPlaceholder")}
          ariaLabel={t("lorebook.secondaryKeysLabel")}
        />
        <Switch
          label={t("lorebook.selectiveLabel")}
          checked={entry.selective}
          onChange={(selective) => onChange({ selective })}
        />
        <Field label={t("lorebook.logicLabel")}>
          <select
            className="field"
            value={entry.selective_logic}
            onChange={(e) => onChange({ selective_logic: Number(e.target.value) as LoreEntry["selective_logic"] })}
          >
            {[0, 1, 2, 3].map((logic) => (
              <option key={logic} value={logic}>{t(`lorebook.logic.${logic}`)}</option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("lorebook.orderLabel")}>
          <NumberField
            value={entry.insertion_order}
            min={-WHOLE}
            onChange={(insertion_order) => onChange({ insertion_order })}
          />
        </Field>
        <Field label={t("lorebook.placeLabel")}>
          <select
            className="field"
            value={place}
            onChange={(e) => onChange({ position: Number(e.target.value) })}
          >
            <option value={0}>{t("lorebook.place.before")}</option>
            <option value={1}>{t("lorebook.place.after")}</option>
            <option value={4}>{t("lorebook.place.depth")}</option>
            {unchosen && (
              <option value={place}>
                {place === 7
                  ? t("lorebook.place.named", { place })
                  : t("lorebook.place.other", { place })}
              </option>
            )}
          </select>
        </Field>
      </div>

      {place === 4 && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("lorebook.depthLabel")}>
            <NumberField value={entry.depth} onChange={(depth) => onChange({ depth })} />
          </Field>
          <Field label={t("lorebook.roleLabel")}>
            <select
              className="field"
              value={entry.role}
              onChange={(e) => onChange({ role: e.target.value as NoteRole })}
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>{t(`lorebook.role.${role}`)}</option>
              ))}
            </select>
          </Field>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <Switch
          label={t("lorebook.wholeWordsLabel")}
          checked={entry.whole_words}
          onChange={(whole_words) => onChange({ whole_words })}
        />
        <Switch
          label={t("lorebook.excludeRecursionLabel")}
          checked={entry.exclude_recursion}
          onChange={(exclude_recursion) => onChange({ exclude_recursion })}
        />
        <Switch
          label={t("lorebook.preventRecursionLabel")}
          checked={entry.prevent_recursion}
          onChange={(prevent_recursion) => onChange({ prevent_recursion })}
        />
      </div>
    </div>
  );
}
