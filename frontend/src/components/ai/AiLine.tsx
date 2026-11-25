import { Tag } from "@/components/ui/Tag";
import { useT } from "@/i18n/useT";
import { priceLine, readsLine, serviceLine, sizeTold, splitName } from "@/lib/ai";
import type { Ai } from "@/types";

/** One AI as Mes IA and the conversation's sheet draw it: its name, what marks it, then where its
 *  service is, what it reads at once and what it costs. `extra` is the room for what a later plan
 *  adds under the line (the estimate of a message's cost). */
export function AiLine({ ai, extra }: { ai: Ai; extra?: React.ReactNode }) {
  const t = useT();
  const [head, tail] = splitName(ai.name);
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {/* Cut in the middle: two models of one family differ at the end of their names. */}
        <span className="flex min-w-0 max-w-full font-display text-sm font-medium text-parchment" title={ai.name}>
          <span className="truncate">{head}</span>
          {tail && <span className="shrink-0 whitespace-pre">{tail}</span>}
        </span>
        {/* White-space normal: at a large text size a tag goes to the next line rather than off the screen. */}
        {ai.is_default && <Tag tone="ember" className="whitespace-normal">{t("ai.default")}</Tag>}
        {ai.reasons === true && <Tag tone="arcane" className="whitespace-normal">{t("ai.thinksBeforeWriting")}</Tag>}
      </div>
      <p className="mt-0.5 text-xs leading-relaxed text-mist [overflow-wrap:anywhere]">
        {[serviceLine(ai, t), readsLine(sizeTold(ai) ? ai.context.used : null, t), priceLine(ai.price, ai.free, t)].join(" · ")}
      </p>
      {extra}
    </div>
  );
}
