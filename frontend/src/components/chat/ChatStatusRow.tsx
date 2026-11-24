import { clsx } from "clsx";

/** The line under the input: what answers the conversation, and the keyboard's sentence where there
 *  is a keyboard. It wraps rather than hide anything; a later plan adds its own chip beside the AI's. */
export function ChatStatusRow({ children, keyboardHint }: { children: React.ReactNode; keyboardHint: string | null }) {
  // With nothing to name (an edition with no AIs of its own), the sentence is the line, as it was.
  const alone = children === null || children === undefined || children === false;
  return (
    <div
      data-status-row
      className={clsx("mx-auto mt-1.5 flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-1", alone && "justify-center text-center")}
    >
      {children}
      {keyboardHint && (
        <p className="min-w-0 text-[0.7rem] text-mist-dim [overflow-wrap:anywhere]">{keyboardHint}</p>
      )}
    </div>
  );
}
