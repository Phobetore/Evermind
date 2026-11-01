import { useT } from "@/i18n/useT";
import { isPageLoadError } from "@/lib/lazyPage";
import { RotateCw } from "lucide-react";
import { useRouteError } from "react-router";

/** Shown in place of a page that could not be put on screen, with the
 *  navigation still around it.
 *
 *  Most often it is the page's code that could not be fetched: Evermind was
 *  updated after this tab was opened, which renames the files, or the
 *  connection dropped. That is cured by loading the document again, at the
 *  same address, and the sentence says so. Anything else is a fault in the
 *  page, which loading it again may well repeat, so the sentence only says
 *  that something went wrong. Reloading is offered for both: for the second
 *  it may not help, but it costs nothing and the person is the one to judge,
 *  and a failed fetch that a browser words in a way `lazyPage` does not know
 *  would otherwise leave nothing to do.
 *
 *  Nothing is logged here: the router reports it (`logRouteError`). */
export function PageError() {
  const t = useT();
  const error = useRouteError();
  return (
    <div role="alert" className="flex flex-col items-center gap-5 px-6 py-20 text-center">
      <p className="max-w-sm leading-relaxed text-mist">
        {t(isPageLoadError(error) ? "errors.pageLoad" : "errors.unexpected")}
      </p>
      <button className="btn btn-primary" onClick={() => window.location.reload()}>
        <RotateCw className="h-4 w-4" />
        {t("common.reload")}
      </button>
    </div>
  );
}
