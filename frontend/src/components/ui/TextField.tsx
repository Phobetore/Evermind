import { clsx } from "clsx";
import { useEffect, useId, useRef, useState } from "react";

/** A text saved when the field is left, or on Enter. An empty one goes back to what is saved. */
export function TextField({ label, value, onSave, mono = false }: {
  label: string;
  value: string;
  onSave(value: string): void;
  mono?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  // What was saved, changed (by this field's own save, or elsewhere), is what the field shows.
  const [saved, setSaved] = useState(value);
  if (saved !== value) {
    setSaved(value);
    setText(value);
  }
  // Gone from the page with a text typed and not saved: saved as leaving the field saves it.
  // What was last sent, so that a text sent as the field was left is not sent a second time.
  const sent = useRef(value);
  const latest = useRef({ text, value, onSave });
  useEffect(() => {
    latest.current = { text, value, onSave };
  });
  useEffect(() => () => {
    const { text: typed, value: before, onSave: save } = latest.current;
    const kept = typed.trim();
    if (kept && kept !== before && kept !== sent.current) save(kept);
  }, []);
  return (
    <label className="flex flex-col gap-1.5" htmlFor={id}>
      <span className="ui-label">{label}</span>
      <input
        id={id}
        className={clsx("field", mono && "font-mono")}
        autoComplete="off"
        spellCheck={!mono}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        onBlur={() => {
          const typed = text.trim();
          if (!typed) setText(value);
          else if (typed !== value) {
            sent.current = typed;
            onSave(typed);
          }
        }}
      />
    </label>
  );
}
