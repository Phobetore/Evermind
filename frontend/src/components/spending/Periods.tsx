import { useT } from "@/i18n/useT";
import type { Period } from "@/lib/spending";
import { clsx } from "clsx";

const ORDER: Period[] = ["7", "30", "month", "last", "all"];

/** A choice of several pressed buttons: the one in force pressed. They go to the next line rather
 *  than past the screen, and each stays 44 px high, a finger's width. */
export function choiceClass(pressed: boolean): string {
  return clsx(
    "min-h-11 max-w-full rounded-lg border px-3 py-1.5 text-center text-sm whitespace-normal break-words",
    pressed ? "border-ember-500 bg-ember-glow text-parchment" : "border-ink-600 text-mist hover:text-parchment",
  );
}

/** The five periods of Spending. */
export function Periods({ value, onChange }: { value: Period; onChange(per: Period): void }) {
  const t = useT();
  return (
    <div role="group" aria-label={t("spending.period.label")} className="flex flex-wrap gap-2">
      {ORDER.map((per) => (
        <button key={per} type="button" aria-pressed={per === value} className={choiceClass(per === value)} onClick={() => onChange(per)}>
          {t(`spending.period.${per}`)}
        </button>
      ))}
    </div>
  );
}
