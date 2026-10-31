import { Delayed } from "@/components/ui/Delayed";
import { useT } from "@/i18n/useT";

/** Takes the place of the page while its code is fetched on a direct load,
 *  with the navigation already up around it. Says nothing at first; then the
 *  same line, in the same look, that the pages use while their data is on its
 *  way. */
export function PageFallback() {
  const t = useT();
  return (
    <Delayed>
      <div className="p-10 text-mist animate-pulse-soft">{t("common.loading")}</div>
    </Delayed>
  );
}
