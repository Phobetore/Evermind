import { PlainText } from "@/components/ui/PlainText";
import { layoutRefusal } from "@/lib/presentation/bounds";
import { boundDepth, noDefinitions } from "@/lib/presentation/markdown";
import { clsx } from "clsx";
import { memo, useMemo, type ReactElement } from "react";
import ReactMarkdown from "react-markdown";

const ALLOWED = ["p", "em", "strong", "code", "blockquote", "br", "ul", "ol", "li", "hr"];

/** A message's Markdown as React elements, or null when it is not laid out: layoutRefusal(text)
 *  refuses it, or something in the chain throws. Never throws. */
export function rpMarkdown(text: string): ReactElement | null {
  // A few kilobytes of markers would freeze the page: measured before anything parses them.
  if (layoutRefusal(text) !== null) return null;
  try {
    // Called as a function, not drawn as a component: in react-markdown 10.1 it calls no hook, it
    // builds its processor, runs it and returns the elements, so that a RangeError of its
    // recursive walks lands in this catch instead of taking the whole page down.
    return ReactMarkdown({
      children: text,
      allowedElements: ALLOWED,
      unwrapDisallowed: true,
      remarkPlugins: [noDefinitions],
      rehypePlugins: [boundDepth],
    });
  } catch {
    return null;
  }
}

/** Roleplay text: markdown where *asterisk actions* render as arcane italics
    (styling lives in .rp-prose). Read again only when the text changes; shown as written when it
    cannot be laid out. */
export const RpText = memo(function RpText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const laidOut = useMemo(() => rpMarkdown(text), [text]);
  return (
    <div className={clsx("rp-prose", streaming && "stream-caret")}>
      {laidOut ?? <PlainText text={text} />}
    </div>
  );
});
