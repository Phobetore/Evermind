import { HOST_MARK, withHosts } from "@/components/cards/hosts";
import { data } from "@/data";
import { useT } from "@/i18n/useT";
import { imageSource } from "@/lib/presentation/images";
import { firstCodePoints } from "@/lib/utils";
import { ImageOff } from "lucide-react";
import { createContext, useContext, useId, useMemo, useState } from "react";

/** Whether the person asked for every image of another site of this presentation, on this visit. */
export const RemoteImagesShown = createContext(false);
/** Whether an image is inside a link: a button there would be touched for the link, or the other way. */
export const InLink = createContext(false);

/** An image of a presentation, from the properties of its element in the tree, as
 *  hast-util-to-jsx-runtime passes them (style already an object). Written into the card, it is
 *  shown at once; from another site, only once the person taps; anything else is a place that
 *  says what was there. */
export function PresentationImage({
  src,
  alt,
  title,
  width,
  height,
  style,
  "data-over-budget": overBudget,
}: {
  src?: string;
  alt?: string;
  title?: string;
  width?: number | string;
  height?: number | string;
  style?: React.CSSProperties;
  "data-over-budget"?: string; // set by cardRules
}) {
  const t = useT();
  // Its header is read once per image mounted: a JPEG of 7 MB is not read again on every redraw.
  const source = useMemo(() => imageSource(src), [src]);
  const showAll = useContext(RemoteImagesShown);
  const inLink = useContext(InLink);
  const [tapped, setTapped] = useState(false);
  const [failed, setFailed] = useState(false);
  const altId = useId();

  const place = (words: React.ReactNode, button?: React.ReactNode) => (
    // Drawn by the application, without the card's style, above whatever the card paints in the
    // frame (card-placeholder): a place must look like one, and its button is the one touched.
    <span className="card-placeholder inline-flex min-h-11 max-w-full flex-col items-start justify-center gap-1 rounded-lg border border-dashed border-ink-600 px-3 py-2 align-middle text-sm text-mist [overflow-wrap:anywhere]">
      <span className="flex min-w-0 max-w-full items-center gap-2">
        <ImageOff className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0">{words}</span>
      </span>
      {alt && (
        // The card's own words, on a line of their own: they can neither push the page nor read
        // as the application's.
        <span id={altId} className="line-clamp-2 max-w-full [overflow-wrap:anywhere]">
          <bdi className="italic">{firstCodePoints(alt, 2_000)}</bdi>
        </span>
      )}
      {button}
    </span>
  );

  if (overBudget !== undefined) return place(t("characters.presentation.imageOverBudget"));

  if (source.kind === "inline" || (source.kind === "remote" && data.remoteImages && (showAll || tapped) && !failed)) {
    return (
      <img
        src={source.src}
        alt={alt}
        title={title}
        width={width}
        height={height}
        style={style}
        loading="lazy"
        decoding="async"
        // Our header already keeps the app's address from other sites; this keeps it where a
        // page is served without it (the Anna edition, the development server).
        referrerPolicy="no-referrer"
        onError={source.kind === "remote" ? () => setFailed(true) : undefined}
      />
    );
  }

  if (source.kind === "tooLarge") {
    return place(t("characters.presentation.imageTooLarge", { width: source.width, height: source.height }));
  }

  if (source.kind === "remote") {
    if (failed) return place(withHosts(t("characters.presentation.imageUnavailable", { host: HOST_MARK }), [source.host]));
    return place(
      withHosts(t("characters.presentation.imageFrom", { host: HOST_MARK }), [source.host]),
      data.remoteImages && !inLink && (
        <button
          type="button"
          className="btn btn-ghost min-h-11"
          aria-label={t("characters.presentation.showFrom", { host: source.host })}
          aria-describedby={alt ? altId : undefined}
          onClick={() => setTapped(true)}
        >
          {t("characters.presentation.show")}
        </button>
      ),
    );
  }

  return place(t("characters.presentation.imageRefused"));
}
