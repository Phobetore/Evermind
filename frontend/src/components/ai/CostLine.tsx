import { useI18n } from "@/i18n/I18nProvider";
import { readerOfAi } from "@/lib/estimate";
import { measuredText } from "@/lib/spending";
import type { Ai, WayFields } from "@/types";
import { EstimateLine } from "./EstimateLine";

/** What 100 messages of an AI cost, as the `extra` of its line in My AIs and on its page: measured
 *  from its last replies once it has enough of them, else estimated as before. Where an AI is
 *  chosen in a conversation, the estimate alone is shown (EstimateLine). */
export function CostLine({ ai, way }: { ai: Ai; way: WayFields }) {
  const { t, locale } = useI18n();
  if (ai.per100 && !ai.free) {
    return (
      <span data-measured className="mt-0.5 block text-xs leading-relaxed text-mist [overflow-wrap:anywhere]">
        {measuredText(ai.per100, locale, t)}
      </span>
    );
  }
  return <EstimateLine reader={readerOfAi(ai)} way={way} />;
}
