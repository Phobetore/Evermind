import { Mark } from "./Mark";

/** A whole page with nothing to show yet: Evermind's mark, turning, above the words that say what it
 *  waits for. The words are what a screen reader reads; the page replaces all of it once it has its
 *  data, so nothing below moves when it goes. Not for a wait inside a page already drawn, nor in a
 *  button: there a quieter line or a spinner says it. */
export function PageWait({ words }: { words: string }) {
  return (
    <div className="p-10 text-mist">
      <Mark decorative busy className="mb-3 h-8 w-8 text-ember-400" />
      <p>{words}</p>
    </div>
  );
}
