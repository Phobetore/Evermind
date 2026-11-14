import { Tag, TagText } from "@/components/ui/Tag";
import { useT } from "@/i18n/useT";
import { useState } from "react";

// A card keeps every tag it was read with, with no bound of number: on a phone, a thousand would
// push what follows out of reach.
const SHOWN_FIRST = 8;

/** A card's tags as the header shows them, on the page and in the summary: the first eight, each
 *  on one line at most, then a « +N » button that shows the others for this mount. Nothing when
 *  there is none. */
export function CardTags({ tags }: { tags: string[] }) {
  const t = useT();
  const [all, setAll] = useState(false);
  if (tags.length === 0) return null;
  const shown = all ? tags : tags.slice(0, SHOWN_FIRST);
  const others = tags.length - shown.length;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      {shown.map((tag, i) => (
        // A card may carry the same tag twice.
        <Tag key={i} className="max-w-full">
          <TagText tag={tag} />
        </Tag>
      ))}
      {others > 0 && (
        <button
          type="button"
          className="btn btn-ghost min-h-11 px-3 py-1 text-xs"
          aria-label={t("characters.detail.moreTagsLabel", { count: others })}
          onClick={() => setAll(true)}
        >
          {t("characters.detail.moreTags", { count: others })}
        </button>
      )}
    </div>
  );
}
