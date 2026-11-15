import { HOST_MARK, withHosts } from "@/components/cards/hosts";
import { PresentationImage, RemoteImagesShown } from "@/components/cards/PresentationImage";
import { PresentationLink } from "@/components/cards/PresentationLink";
import { PlainText } from "@/components/ui/PlainText";
import { data } from "@/data";
import { useT } from "@/i18n/useT";
import { plainPresentation } from "@/lib/cards/read";
import type { renderPresentation } from "@/lib/presentation/renderPresentation";
import { toJsxRuntime, type Components } from "hast-util-to-jsx-runtime";
import { useEffect, useMemo, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

type Render = typeof renderPresentation;

// The layout is asked for only where a presentation is shown: imported anywhere else, the HTML
// parser would be in the main file, and a start on a slow link would pay for a page most visits
// never open. Kept while it succeeds or waits; a failure clears it, so that the next presentation
// mounted asks again (once per mount, never in a loop).
let loading: Promise<Render> | null = null;
let loaded: Render | null = null;

function loadLayout(): Promise<Render> {
  loading ??= import("@/lib/presentation/renderPresentation").then(
    (module) => (loaded = module.renderPresentation),
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/** Hands the layout to `got` once it is here, or tells `failed` it could not be had; the function
 *  returned stops both. The layout may have arrived between a presentation's first draw and its
 *  effect, for an import an earlier presentation started: it is then handed over at once, or that
 *  presentation would stay plain for good. Exported for its test. */
export function whenLayout(got: (render: Render) => void, failed: () => void): () => void {
  if (loaded) {
    got(loaded);
    return () => {};
  }
  let live = true;
  loadLayout().then(
    (render) => live && got(render),
    () => live && failed(),
  );
  return () => {
    live = false;
  };
}

const COMPONENTS = { a: PresentationLink, img: PresentationImage } as unknown as Partial<Components>;

/** A site's name for the line of the sites contacted: its last 32 characters, the end of a name
 *  being what says whose the site is. A hostname is ASCII: the cut falls inside no character. */
const shortHost = (host: string) => (host.length > 32 ? "…" + host.slice(-32) : host);

/** A card's presentation, in a frame that is there from the first draw: laid out once the layout
 *  has arrived, shown as plain text until then, if it never does, or past the bounds. */
export function Presentation({ text }: { text: string }) {
  const t = useT();
  const [render, setRender] = useState<{ render: Render } | null>(() => (loaded ? { render: loaded } : null));
  const [missing, setMissing] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(
    () =>
      whenLayout(
        (got) => setRender((now) => (now?.render === got ? now : { render: got })),
        () => setMissing(true),
      ),
    [],
  );

  const rendered = useMemo(() => (render ? render.render(text) : null), [render, text]);
  const laidOut = rendered?.kind === "laid-out" ? rendered : null;
  const content = useMemo(
    () =>
      laidOut &&
      toJsxRuntime(laidOut.tree, { Fragment, jsx, jsxs, components: COMPONENTS, ignoreInvalidStyle: true }),
    [laidOut],
  );
  // Linear, but 15 MB are not read again on every render.
  const plain = useMemo(() => (laidOut ? "" : plainPresentation(text)), [laidOut, text]);

  // A layout that failed on its way (a nesting too deep for a walk) is a text too dense for it: the
  // person is told why it is plain, as past a bound.
  const reason = rendered?.kind === "plain" ? (rendered.reason === "failed" ? "tooDense" : rendered.reason) : null;
  const hosts = laidOut?.remoteHosts ?? [];
  const named = hosts.slice(0, 3).map(shortHost);

  return (
    <div>
      {/* Above the frame, never in it: these are the application's, and under the frame the fold
          would hide them. */}
      {missing && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-mist">
          <p>{t("characters.presentation.layoutMissing")}</p>
          <button type="button" className="btn btn-ghost min-h-11" onClick={() => window.location.reload()}>
            {t("characters.presentation.reload")}
          </button>
        </div>
      )}
      {reason && <p className="mb-3 text-sm text-mist">{t(`characters.presentation.${reason}`)}</p>}
      {hosts.length > 0 &&
        (data.remoteImages ? (
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-mist">
            <button type="button" className="btn btn-ghost min-h-11" disabled={showAll} onClick={() => setShowAll(true)}>
              {t("characters.presentation.showImages")}
            </button>
            <p className="min-w-0 [overflow-wrap:anywhere]">
              {withHosts(
                hosts.length > 3
                  ? t("characters.presentation.contactsMore", { hosts: HOST_MARK, count: hosts.length - 3 })
                  : t("characters.presentation.contacts", { hosts: HOST_MARK }),
                named,
              )}
            </p>
          </div>
        ) : (
          <p className="mb-3 text-sm text-mist">{t("characters.presentation.noRemoteImages")}</p>
        ))}
      <div className="card-presentation">
        {content ? (
          <RemoteImagesShown.Provider value={showAll}>{content}</RemoteImagesShown.Provider>
        ) : (
          <PlainText text={plain} />
        )}
      </div>
    </div>
  );
}
