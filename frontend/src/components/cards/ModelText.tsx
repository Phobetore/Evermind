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
 *  style of the card's (there is none without HTML), its headings under the field's h3. Shown as
 *  written until the layout arrives, if it never does, or past the bounds, with the line a
 *  presentation shows then. */
export function ModelText({ text, className }: { text: string; className?: string }) {
  const t = useT();
  const [render, setRender] = useState<{ render: Render } | null>(() => (loaded ? { render: loaded } : null));

  useEffect(() => {
    let live = true;
    // Asked for even when the first draw had it not: it may have arrived since, for another text.
    loadLayout().then(
      (got) => live && setRender((now) => (now?.render === got ? now : { render: got })),
      // The text stays shown as written, which is what the model reads.
      () => {},
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
  const reason = rendered?.kind === "plain" && rendered.reason !== "failed" ? rendered.reason : null;

  return (
    <div className={className}>
      {reason && <p className="mb-2 text-sm text-mist">{t(`characters.presentation.${reason}`)}</p>}
      {content ? <div className="card-presentation">{content}</div> : <PlainText text={text} />}
    </div>
  );
}
