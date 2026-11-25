import { levelOf } from "@/engine";
import { useT } from "@/i18n/useT";
import type { Length, Reminders, WayFields } from "@/types";
import { clsx } from "clsx";
import { useId } from "react";

/** What one of the three choices sets: the figures of a way that a touch can change. */
export type WayChange = { history_limit?: number; reply_length?: Length; reminders?: Reminders };
/** The three choices, by name: where each says "Saved.". */
export type WayChoice = "history" | "length" | "reminders";

const HISTORY = [16, 24, 60, 0] as const;
const LENGTHS: Length[] = ["short", "medium", "long"];
const REMINDERS: Reminders[] = ["essential", "normal", "rich", "all"];

/** The three choices of a way, each with its sentence under it: the messages reread, the length of
 *  the replies, the reminders. Shared by a way's page and the conversation's sheet. A way whose
 *  reminders match no level shows "Custom" pressed, which is no choice to make. */
export function WayChoices({ fields, onChange, busy = false, said }: {
  fields: WayFields;
  onChange(change: WayChange): void;
  busy?: boolean;
  /** What a choice says once it is saved, under its sentence. */
  said?: (choice: WayChoice) => React.ReactNode;
}) {
  const t = useT();
  const level = levelOf(fields);
  return (
    <div className="flex flex-col gap-6">
      <Group label={t("ways.history.label")} hint={t("ways.history.hint")} said={said?.("history")}>
        {HISTORY.map((count) => (
          <Choice
            key={count}
            pressed={fields.history_limit === count}
            disabled={busy}
            onClick={() => fields.history_limit !== count && onChange({ history_limit: count })}
          >
            {count === 0 ? t("ways.history.all") : count}
          </Choice>
        ))}
      </Group>
      <Group label={t("ways.length.label")} hint={t("ways.length.hint")} said={said?.("length")}>
        {LENGTHS.map((length) => (
          <Choice
            key={length}
            pressed={fields.reply_length === length}
            disabled={busy}
            onClick={() => fields.reply_length !== length && onChange({ reply_length: length })}
          >
            {t(`ways.length.${length}`)}
          </Choice>
        ))}
      </Group>
      <Group label={t("ways.reminders.label")} hint={t("ways.reminders.hint")} said={said?.("reminders")}>
        {REMINDERS.map((each) => (
          <Choice
            key={each}
            pressed={level === each}
            disabled={busy}
            onClick={() => level !== each && onChange({ reminders: each })}
          >
            {t(`ways.reminders.${each}`)}
          </Choice>
        ))}
        {/* Figures typed in the advanced part: said, never chosen. */}
        {level === null && <Choice pressed disabled onClick={() => {}}>{t("ways.reminders.custom")}</Choice>}
      </Group>
    </div>
  );
}

function Group({ label, hint, said, children }: {
  label: string;
  hint: string;
  said?: React.ReactNode;
  children: React.ReactNode;
}) {
  const ids = useId();
  return (
    <div role="group" aria-labelledby={`${ids}-label`} aria-describedby={`${ids}-hint`} className="flex flex-col gap-2">
      <span id={`${ids}-label`} className="ui-label">{label}</span>
      <div className="flex flex-wrap gap-2">{children}</div>
      <p id={`${ids}-hint`} className="text-xs leading-relaxed text-mist">{hint}</p>
      {said}
    </div>
  );
}

/** As an AI's page draws its choices: never narrower than its longest word, the next one taken to a
 *  line of its own when a row has no room for them side by side. */
function Choice({ pressed, disabled, onClick, children }: {
  pressed: boolean;
  disabled: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "flex min-h-11 max-w-full flex-1 items-center justify-center rounded-lg border px-2 py-1.5 text-center text-sm",
        pressed ? "border-ember-500 bg-ember-glow text-parchment" : "border-ink-600 text-mist hover:text-parchment",
        "disabled:cursor-default",
      )}
    >
      <span className="break-words">{children}</span>
    </button>
  );
}
