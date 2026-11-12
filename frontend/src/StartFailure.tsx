import type { Translate } from "@/i18n/I18nProvider";
import { describeError } from "@/lib/errors";
import { RotateCw } from "lucide-react";

/** A page of its own, with nothing of the application around it: the application cannot be drawn,
 *  so it takes the words it needs as a plain function rather than from the language provider. */
export function StartFailure({ error, t }: { error: unknown; t: Translate }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-5 px-6 py-20 text-center">
      <p className="max-w-sm leading-relaxed text-mist">{describeError(error, t)}</p>
      <button className="btn btn-primary" onClick={() => window.location.reload()}>
        <RotateCw className="h-4 w-4" />
        {t("common.reload")}
      </button>
    </div>
  );
}
