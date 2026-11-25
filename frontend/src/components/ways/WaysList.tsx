import { Tag } from "@/components/ui/Tag";
import { useI18n } from "@/i18n/I18nProvider";
import { estimateOf, estimateText, readerOfAi } from "@/lib/estimate";
import { wayName } from "@/lib/ways";
import type { Ai, WayListed, Ways } from "@/types";
import { ChevronRight } from "lucide-react";
import { useId } from "react";
import { Link } from "react-router";

/** The ways that have a sentence of their own: the four built in. */
const SAID = new Set(["light", "balanced", "immersive", "maximum"]);

/** Settings' block of the ways to play: one line for each, which leads to its page, with what 100
 *  messages would cost under it with the default AI, where there are AIs. */
export function WaysList({ ways, ais }: { ways: Ways; ais: Ai[] | null }) {
  const { t } = useI18n();
  const title = useId();
  const ai = ais && (ais.find((each) => each.is_default) ?? ais[0] ?? null);
  return (
    <section className="mb-10" aria-labelledby={title}>
      <h2 id={title} className="ui-label mb-4">{t("ways.title")}</h2>
      <ul className="stagger flex flex-col gap-3">
        {ways.ways.map((way) => (
          <li key={way.id}>
            <Link
              to={`/settings/way/${encodeURIComponent(way.id)}`}
              // The gutters are layout, not text: in pixels at most, or the largest text squeezes the words.
              className="panel flex items-center justify-between gap-[min(0.75rem,12px)] px-[min(1.25rem,20px)] py-4 hover:border-ink-600"
            >
              <WayLine way={way} offered={way.id === ways.default} ai={ai} />
              <ChevronRight className="h-4 w-4 shrink-0 text-mist" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function WayLine({ way, offered, ai }: { way: WayListed; offered: boolean; ai: Ai | null }) {
  const { t, locale } = useI18n();
  const estimate = ai && estimateOf(readerOfAi(ai), way);
  return (
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 font-display text-sm font-medium text-parchment [overflow-wrap:anywhere]">
          {wayName(way, t)}
        </span>
        {/* White-space normal: at a large text size the tag goes to the next line rather than off the screen. */}
        {offered && <Tag tone="ember" className="whitespace-normal">{t("ways.defaultTag")}</Tag>}
        {/* Only a figure: a free AI, or one with no price, says so on its own line in My AIs. */}
        {estimate?.kind === "amount" && (
          <span className="ml-auto text-xs text-mist">{estimateText(estimate, locale, t)}</span>
        )}
      </div>
      <p className="mt-0.5 text-xs leading-relaxed text-mist">
        {t(SAID.has(way.id) ? `ways.summary.${way.id}` : "ways.summary.custom")}
      </p>
      <p className="mt-0.5 text-xs text-mist-dim">{t("ways.count", { count: way.conversations })}</p>
    </div>
  );
}
