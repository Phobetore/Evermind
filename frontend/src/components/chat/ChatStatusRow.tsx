import { clsx } from "clsx";

/** The line under the input: what answers the conversation, and the keyboard's sentence where there
 *  is a keyboard. It wraps rather than hide anything; a later plan adds its own chip beside the AI's.
 *  `hintAside`: the sentence steps aside, where the line over the input leaves it no room. It keeps
 *  its place in the row at no height, so that what it would take can still be measured. */
export function ChatStatusRow({ children, keyboardHint, hintAside = false }: {
  children: React.ReactNode;
  keyboardHint: string | null;
  hintAside?: boolean;
}) {
  // With nothing to name (an edition with no AIs of its own), the sentence is the line, as it was.
  const alone = children === null || children === undefined || children === false;
  return (
    <div
      data-status-row
      className={clsx("mx-auto mt-1.5 flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-1", alone && "justify-center text-center")}
    >
      {children}
      {keyboardHint && (
        <p
          data-keyboard-hint
          data-aside={hintAside || undefined}
          aria-hidden={hintAside || undefined}
          className={clsx("min-w-0 text-[0.7rem] text-mist-dim [overflow-wrap:anywhere]", hintAside && "invisible h-0 overflow-hidden")}
        >
          {keyboardHint}
        </p>
      )}
    </div>
  );
}
