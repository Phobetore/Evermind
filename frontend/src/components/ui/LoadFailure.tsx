import { useT } from "@/i18n/useT";
import { describeError } from "@/lib/errors";

/** In place of what could not be read, with a way to read it again. */
export function LoadFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const t = useT();
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-4 rounded-xl border border-blood/40 bg-blood/10 px-4 py-3"
    >
      <p className="text-sm text-blood">{describeError(error, t)}</p>
      <button type="button" className="btn btn-ghost shrink-0 !py-1.5 text-sm" onClick={onRetry}>
        {t("common.reload")}
      </button>
    </div>
  );
}
