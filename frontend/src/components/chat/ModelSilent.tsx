import { useT } from "@/i18n/useT";
import { Unplug } from "lucide-react";
import { Link } from "react-router";

/** Said when the model did not answer at all, most often because the AI server behind it is not
 *  running. Not the red banner of a fault: nothing is broken, and a warning that looks like damage
 *  sends people looking for damage. Not the hint line either, where it would go unseen. */
export function ModelSilent({ onRetry }: { onRetry?: () => void }) {
  const t = useT();
  return (
    <div className="mx-auto flex max-w-3xl items-start gap-2.5 rounded-xl border border-ember-500/30 bg-ember-glow px-3.5 py-2.5 text-sm">
      <Unplug className="mt-0.5 h-4 w-4 shrink-0 text-ember-400" />
      <p role="alert" className="min-w-0 flex-1 leading-relaxed text-parchment-dim">
        {t("chat.modelSilent.title")}{" "}
        <span className="text-mist">{t("chat.modelSilent.hint")}</span>{" "}
        <Link to="/settings" className="whitespace-nowrap text-ember-400 hover:text-ember-300">
          {t("chat.modelSilent.settingsLink")}
        </Link>
      </p>
      {onRetry && (
        <button
          type="button"
          className="btn btn-ghost shrink-0 !py-1 text-xs"
          onClick={onRetry}
        >
          {t("chat.modelSilent.retry")}
        </button>
      )}
    </div>
  );
}
