import type { ShownBackdrop } from "@/lib/display";
import { useState } from "react";

/** The picture behind the story, over the column's whole box and under the part that scrolls, so
 *  that it stays put while the text moves, the keyboard open or not. A picture that fails to load
 *  hands over to its fallback (the whole portrait for a missing copy), then to nothing. */
export function Backdrop({ shown }: { shown: ShownBackdrop }) {
  // What failed, by address: a backdrop that changes starts from its own first choice.
  const [broken, setBroken] = useState<readonly string[]>([]);
  const src = [shown.src, shown.fallback].find((s): s is string => s !== null && !broken.includes(s)) ?? null;
  return (
    <div aria-hidden data-backdrop className="chat-backdrop pointer-events-none absolute inset-0 overflow-hidden">
      {src && (
        <img
          key={src}
          src={src}
          alt=""
          decoding="async"
          draggable={false}
          data-kind={shown.kind ?? undefined}
          style={{ opacity: shown.strength }}
          onError={() => setBroken((now) => [...now, src])}
        />
      )}
    </div>
  );
}
