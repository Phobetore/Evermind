import { data, type DataSource } from "@/data";
import type { Translate } from "@/i18n/I18nProvider";
import { spendingShown } from "@/lib/spending";

/** What a window of deletion says is kept of what was spent; null in an edition without Spending. */
export function keptSaid(t: Translate, source: Pick<DataSource, "spending"> = data): string | null {
  return spendingShown(source) ? t("spending.kept") : null;
}

/** What a window of deletion says is kept of what was spent, and its tick to keep it under no
 *  name, unticked. The tick is read once the yes is given: the box is gone by then, so it is
 *  followed as it changes rather than read from the page. Null in an edition without Spending. */
export function keptOnDelete(
  t: Translate, source: Pick<DataSource, "spending"> = data,
): { details: React.ReactNode; forgetName: () => boolean } | null {
  const said = keptSaid(t, source);
  if (said === null) return null;
  let ticked = false;
  return {
    details: (
      <>
        <p>{said}</p>
        <label className="touch-target flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            defaultChecked={false}
            onChange={(e) => {
              ticked = e.target.checked;
            }}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[#e29a3e]"
          />
          <span>{t("spending.forgetTick")}</span>
        </label>
      </>
    ),
    forgetName: () => ticked,
  };
}
