import { useT } from "@/i18n/useT";
import { describeError } from "@/lib/errors";

/** In place of what could not be read, with a way to read it again: the button goes under the
 *  sentence rather than past a narrow box, as in a sheet on a phone. Without `onRetry`, what is
 *  gone for good: no button that could only fail again. */
export function LoadFailure({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useT();
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-blood/40 bg-blood/10 px-4 py-3"
    >
      <p className="min-w-0 text-sm text-blood [overflow-wrap:anywhere]">{describeError(error, t)}</p>
      {onRetry && (
        <button type="button" className="btn btn-ghost max-w-full shrink-0 whitespace-normal !py-1.5 text-sm" onClick={onRetry}>
          {t("common.reload")}
        </button>
      )}
    </div>
  );
}
