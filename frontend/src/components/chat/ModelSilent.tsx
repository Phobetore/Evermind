"use client";

import { useT } from "@/i18n/useT";
import { Unplug } from "lucide-react";
import Link from "next/link";

/** Said when the model did not answer at all — most often because the AI
 *  server behind it is simply not running.
 *
 *  Deliberately not the red banner used for a fault: nothing is broken and
 *  nothing was lost, something just is not switched on, and a warning that
 *  looks like damage sends people looking for damage. Deliberately not the
 *  hint line either, which is where the keyboard tip lives — a failure that
 *  appears there in eleven grey pixels for four seconds is a failure nobody
 *  sees, which is how this came to be reported as dying silently. */
export function ModelSilent({ onRetry }: { onRetry?: () => void }) {
  const t = useT();
  return (
    <div className="mx-auto flex max-w-3xl items-start gap-2.5 rounded-xl border border-ember-500/30 bg-ember-glow px-3.5 py-2.5 text-sm">
      <Unplug className="mt-0.5 h-4 w-4 shrink-0 text-ember-400" />
      <p className="min-w-0 flex-1 leading-relaxed text-parchment-dim">
        {t("chat.modelSilent.title")}{" "}
        <span className="text-mist">{t("chat.modelSilent.hint")}</span>{" "}
        <Link href="/settings" className="whitespace-nowrap text-ember-400 hover:text-ember-300">
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
