import { Delayed } from "@/components/ui/Delayed";
import { useT } from "@/i18n/useT";
import { useNavigation } from "react-router";

/** What says that the page which was asked for is on its way. The page the
 *  person is on stays as it is until the new one can replace it, and without
 *  this nothing would say that the tap was taken: a thin bar along the top of
 *  the screen, and the same in words for those who cannot see it.
 *
 *  Both wait a moment before showing, so a page that arrives at once changes
 *  nothing but itself. The bar is fixed, below the notch of a phone, so it
 *  moves nothing; for someone who asks for less motion it is a bar that sits
 *  still, the width of the screen, instead of a stretch of it sliding. */
export function NavigationProgress() {
  const { state } = useNavigation();
  const t = useT();
  const pending = state !== "idle";
  return (
    <>
      {/* Always in the page, empty until there is something to say: a region
          that appears with its words already in it is not read out by every
          screen reader. */}
      <div role="status" aria-live="polite" className="sr-only">
        {pending && <Delayed>{t("common.loading")}</Delayed>}
      </div>
      {pending && (
        <Delayed>
          <div
            role="progressbar"
            aria-label={t("common.loading")}
            // The page reaches the edges of the screen (viewport-fit=cover).
            style={{ top: "env(safe-area-inset-top)" }}
            className="pointer-events-none fixed inset-x-0 z-40 h-0.5 overflow-hidden"
          >
            <div className="h-full w-full bg-ember-400 motion-safe:w-1/3 motion-safe:animate-pending" />
          </div>
        </Delayed>
      )}
    </>
  );
}
