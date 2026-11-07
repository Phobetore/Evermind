import { useT } from "@/i18n/useT";
import { RotateCw } from "lucide-react";

/** In place of a page that broke, with the navigation still around it. */
export function PageError() {
  const t = useT();
  return (
    <div role="alert" className="flex flex-col items-center gap-5 px-6 py-20 text-center">
      <p className="max-w-sm leading-relaxed text-mist">{t("errors.unexpected")}</p>
      <button className="btn btn-primary" onClick={() => window.location.reload()}>
        <RotateCw className="h-4 w-4" />
        {t("common.reload")}
      </button>
    </div>
  );
}
