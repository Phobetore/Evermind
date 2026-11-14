import { useId } from "react";

/**
 * Evermind's mark: a ball half-mask whose one eye is an almond and whose other is a four-pointed
 * spark. Both eyes are openings cut by a <mask>, so the mark sits on any surface in one colour,
 * `currentColor`; its size is its classes'.
 *
 * It moves by CSS alone (styles.css, "The mark"): the spark winks when the pointer comes over the
 * link or button that holds it (or an element marked `data-mark-host`), or when that takes the
 * keyboard focus; and it turns while `busy`. A mark alone, like the login's, does not wink, and a busy
 * mark does not wink. The spark is drawn around 0,0 and placed by its parent, so
 * a transform turns or closes it about its own centre.
 *
 * The moving spark is inside the mask. An engine that does not repaint a mask's contents under a CSS
 * animation (older WebKit has been known not to) shows the spark still: the mark is whole, it only
 * does not move there.
 */
/** The id of a mark's mask, from React's `useId()`: kept to what an unquoted url(#…) reads. React 19
 *  gives `_r_1_`, which needs nothing; React 18 gave `:r0:` and a canary `«r0»`, which would leave the
 *  mark without its openings. This guards the mark against the next form React picks. */
export function maskId(reactId: string) {
  return `mark-mask${reactId.replace(/[^\w-]/g, "")}`;
}

export function Mark({ className, busy = false, decorative = false }: {
  className?: string;
  /** Evermind is waiting on itself: the spark turns. */
  busy?: boolean;
  /** Beside the word Evermind: hidden from a screen reader, which would read the name twice. */
  decorative?: boolean;
}) {
  // One mask per mark: two sharing an id would cut both with the first one's.
  const mask = maskId(useId());
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 -4.2 64 64"
      className={className}
      focusable="false"
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": "Evermind" })}
    >
      <g className="mark mark--perce" data-busy={busy ? "true" : undefined}>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect width="64" height="64" fill="#fff" />
          <path className="mark-eye" d="M26.5 30C24 23.4 17 21.9 12 26.5C15.5 33.9 23 34.9 26.5 30Z" fill="#000" />
          <g className="mark-spark-at" transform="translate(45 29.5)">
            <path
              className="mark-spark"
              d="M0 -10C3.3 -3.3 3.3 -3.3 10 0C3.3 3.3 3.3 3.3 0 10C-3.3 3.3 -3.3 3.3 -10 0C-3.3 -3.3 -3.3 -3.3 0 -10Z"
              fill="#000"
            />
          </g>
        </mask>
        <path
          className="mark-body"
          d="M32 22C38 19 44 17.5 50 17C54 16.5 57 14.5 59.5 10C61.5 18 61 27 57 34C54 40 48 45.5 42 45C37.5 44.5 34.5 40 32 37C29.5 40 26.5 44.5 22 45C16 45.5 10 40 7 34C3 27 2.5 18 4.5 10C7 14.5 10 16.5 14 17C20 17.5 26 19 32 22Z"
          fill="currentColor"
          mask={`url(#${mask})`}
        />
      </g>
    </svg>
  );
}
