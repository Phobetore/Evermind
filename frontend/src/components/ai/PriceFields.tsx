import { decimalOf, FigureField } from "@/components/ui/FigureField";
import type { ModelUpdate } from "@/data";
import type { Translate } from "@/i18n/I18nProvider";
import type { Ai } from "@/types";
import { useId } from "react";

export type Save = (at: string, change: ModelUpdate) => Promise<void>;
export type Said = (at: string) => React.ReactNode;

/** Its price, typed, when the server gives none: per million tokens read and written. A negative
 *  one is sent as typed, for the server's refusal to be said under the fields rather than the
 *  figure dropped in silence. */
export function PriceFields({ ai, t, hint, onSave, said }: { ai: Ai; t: Translate; hint: string; onSave: Save; said: Said }) {
  const ids = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm text-parchment-dim">{t("ai.list.priceTitle")}</p>
      {/* Side by side, even at 320px in the advanced part (113px each); stacked only at large text. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,6.5rem),1fr))] gap-3">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-mist" htmlFor={`${ids}-in`}>
          {t("ai.list.priceIn")}
          <FigureField
            parse={decimalOf}
            id={`${ids}-in`}
            value={ai.price.own_in}
            onSave={(value) => void onSave("price", { price_own_in: value })}
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-mist" htmlFor={`${ids}-out`}>
          {t("ai.list.priceOut")}
          <FigureField
            parse={decimalOf}
            id={`${ids}-out`}
            value={ai.price.own_out}
            onSave={(value) => void onSave("price", { price_own_out: value })}
          />
        </label>
      </div>
      {said("price")}
      <p className="text-xs text-mist">{hint}</p>
    </div>
  );
}
