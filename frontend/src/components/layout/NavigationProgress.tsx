import { Delayed } from "@/components/ui/Delayed";
import { useT } from "@/i18n/useT";
import { useNavigation } from "react-router";

/** A thin bar along the top of the screen while the page that was asked for is
 *  on its way. The page the person is on stays as it is until the new one can
 *  replace it, and without this nothing would say that the tap was taken. It
 *  waits a moment before showing, so a page that arrives at once changes
 *  nothing on screen but itself, and it is fixed in place, so it moves
 *  nothing either. */
export function NavigationProgress() {
  const { state } = useNavigation();
  const t = useT();
  if (state === "idle") return null;
  return (
    <Delayed>
      <div
        role="progressbar"
        aria-label={t("common.loading")}
        className="pointer-events-none fixed inset-x-0 top-0 z-40 h-0.5 overflow-hidden"
      >
        <div className="h-full w-1/3 animate-pending bg-ember-400" />
      </div>
    </Delayed>
  );
}
