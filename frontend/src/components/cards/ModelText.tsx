import { PlainText } from "@/components/ui/PlainText";
import { useT } from "@/i18n/useT";
import type { renderModelText } from "@/lib/presentation/renderPresentation";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { useEffect, useMemo, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

type Render = typeof renderModelText;

// The layout's own file, asked for only once what the model reads is opened: imported anywhere
// else, its parsers would be in the main file. Kept while it succeeds or waits; a failure clears
// it, so that the next text mounted asks again.
let loading: Promise<Render> | null = null;
let loaded: Render | null = null;

function loadLayout(): Promise<Render> {
  loading ??= import("@/lib/presentation/renderPresentation").then(
    (module) => (loaded = module.renderModelText),
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/** A text the model reads, laid out as Markdown alone, with a presentation's typography and no
 *  style of the card's (there is none without HTML), its headings under the field's h3; or as
 *  written when `asWritten`. Shown as written too until the layout arrives, if it never does (with
 *  the line and the Reload button a presentation shows then), or past the bounds (with the line a
 *  presentation shows then). One frame in every case: the field does not jump when the layout
 *  lands, nor at each switch. The layout is kept while the text is shown as written, so that
 *  switching back costs nothing. */
export function ModelText({ text, asWritten = false, className }: { text: string; asWritten?: boolean; className?: string }) {
  const t = useT();
  const [render, setRender] = useState<{ render: Render } | null>(() => (loaded ? { render: loaded } : null));
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let live = true;
    // Asked for even when the first draw had it not: it may have arrived since, for another text.
    loadLayout().then(
      (got) => live && setRender((now) => (now?.render === got ? now : { render: got })),
      () => live && setMissing(true),
    );
    return () => {
      live = false;
    };
  }, []);

  const rendered = useMemo(() => (render ? render.render(text) : null), [render, text]);
  const content = useMemo(
    () =>
      rendered?.kind === "laid-out"
        ? toJsxRuntime(rendered.tree, { Fragment, jsx, jsxs, ignoreInvalidStyle: true })
        : null,
    [rendered],
  );
  // A layout that failed on its way (a nesting too deep for a walk) is a text too dense for it: the
  // person is told why it is plain, as past a bound.
  const reason = rendered?.kind === "plain" ? (rendered.reason === "failed" ? "tooDense" : rendered.reason) : null;

  return (
    <div className={className}>
      {/* Above the frame, and only when the layout was asked for: as written is what was chosen. */}
      {!asWritten && missing && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-mist">
          <p>{t("characters.presentation.layoutMissing")}</p>
          <button type="button" className="btn btn-ghost min-h-11" onClick={() => window.location.reload()}>
            {t("characters.presentation.reload")}
          </button>
        </div>
      )}
      {!asWritten && reason && <p className="mb-2 text-sm text-mist">{t(`characters.presentation.${reason}`)}</p>}
      <div className="card-presentation">{(!asWritten && content) || <PlainText text={text} />}</div>
    </div>
  );
}
