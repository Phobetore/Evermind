"use client";

import { clsx } from "clsx";
import ReactMarkdown from "react-markdown";

/** Roleplay text: markdown where *asterisk actions* render as arcane italics
    (styling lives in .rp-prose). */
export function RpText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className={clsx("rp-prose", streaming && "stream-caret")}>
      <ReactMarkdown allowedElements={["p", "em", "strong", "code", "blockquote", "br", "ul", "ol", "li", "hr"]} unwrapDisallowed>
        {text}
      </ReactMarkdown>
    </div>
  );
}
