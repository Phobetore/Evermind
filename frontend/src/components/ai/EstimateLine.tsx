import { useI18n } from "@/i18n/I18nProvider";
import { estimateOf, estimateText, type Reader } from "@/lib/estimate";
import type { WayFields } from "@/types";

/** What 100 messages of an AI cost under a way, as the `extra` of its line. Nothing for one that
 *  is free, has no price or a price that varies: its line says so already. A span, as a row of the
 *  add list holds it inside its label. */
export function EstimateLine({ reader, way }: { reader: Reader; way: WayFields }) {
  const { t, locale } = useI18n();
  const estimate = estimateOf(reader, way);
  if (estimate.kind !== "amount") return null;
  return (
    <span data-estimate className="mt-0.5 block text-xs leading-relaxed text-mist [overflow-wrap:anywhere]">
      {estimateText(estimate, locale, t)}
    </span>
  );
}
