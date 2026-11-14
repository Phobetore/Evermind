import { Fragment } from "react";

/** A character no translation holds, put in a sentence where a site's name goes. */
export const HOST_MARK = "⁣";

/** The sentence t(key, { host: HOST_MARK }) (or hosts:) with the mark replaced by each host in a
 *  <bdi> in the monospace font, joined by ", ": the name of a site shown as one, never read as
 *  words of the application. The sentence wraps anywhere ([overflow-wrap:anywhere]). */
export function withHosts(sentence: string, hosts: string[]): React.ReactNode {
  // A host is chosen by the card's author: the <bdi> keeps a name written right to left from
  // reordering the words of the sentence around it.
  const named = hosts.map((host, i) => (
    <Fragment key={i}>
      {i > 0 && ", "}
      <bdi className="font-mono">{host}</bdi>
    </Fragment>
  ));
  return (
    <span className="[overflow-wrap:anywhere]">
      {sentence.split(HOST_MARK).map((part, i) => (
        <Fragment key={i}>
          {i > 0 && named}
          {part}
        </Fragment>
      ))}
    </span>
  );
}
