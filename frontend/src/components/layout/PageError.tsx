import { useT } from "@/i18n/useT";
import { RotateCw } from "lucide-react";

/** Shown in place of a page that could not be put on screen, with the
 *  navigation still around it. Most often it is the page's code that could not
 *  be fetched: Evermind was updated after this tab was opened, which renames
 *  the files, or the connection dropped. A page that failed to load stays
 *  failed until the document itself is loaded again, so retrying means
 *  reloading, at the same address. */
export function PageError() {
  const t = useT();
  return (
    <div role="alert" className="flex flex-col items-center gap-5 px-6 py-20 text-center">
      <p className="max-w-sm leading-relaxed text-mist">{t("errors.pageLoad")}</p>
      <button className="btn btn-primary" onClick={() => window.location.reload()}>
        <RotateCw className="h-4 w-4" />
        {t("common.reload")}
      </button>
    </div>
  );
}
