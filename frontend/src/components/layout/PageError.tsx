import { useT } from "@/i18n/useT";
import { isPageLoadError } from "@/lib/lazyPage";
import { RotateCw } from "lucide-react";
import { useEffect } from "react";
import { useRouteError } from "react-router";

/** Shown in place of a page that could not be put on screen, with the
 *  navigation still around it.
 *
 *  Most often it is the page's code that could not be fetched: Evermind was
 *  updated after this tab was opened, which renames the files, or the
 *  connection dropped. That is cured by loading the document again, at the
 *  same address, and says so. Anything else is a fault in the page, which
 *  loading it again would repeat: it says only that something went wrong. */
export function PageError() {
  const t = useT();
  const error = useRouteError();
  const download = isPageLoadError(error);

  // A fault while a page is drawn is logged by the router itself. The failed
  // fetch happens before there is anything to draw, and is not.
  useEffect(() => {
    if (download) console.error("The code of a page could not be loaded:", error.cause);
  }, [download, error]);

  if (!download) {
    return (
      <div role="alert" className="px-6 py-20 text-center leading-relaxed text-mist">
        {t("errors.unexpected")}
      </div>
    );
  }
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
