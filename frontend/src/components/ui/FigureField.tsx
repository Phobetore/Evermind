import { useEffect, useRef, useState } from "react";

/** How long a number typed waits for the next key before it is saved: long enough not to save
 *  every figure of "16384" on its way, short enough to be saved before the page is left. */
export const TYPING_MS = 700;

/** A whole number of tokens as typed, spaces and separators of thousands allowed; "" is none, and
 *  anything else is not a number at all. */
export function tokensOf(text: string): number | null | undefined {
  const plain = text.replace(/[\s.,'  ]/g, "");
  if (plain === "") return null;
  return /^\d+$/.test(plain) ? Number(plain) : undefined;
}

/** A decimal typed with a comma or a point; "" is none, and anything else is not a number at all. */
export function decimalOf(text: string): number | null | undefined {
  const plain = text.trim().replace(",", ".");
  if (plain === "") return null;
  const value = Number(plain);
  return Number.isFinite(value) ? value : undefined;
}

/** What a control's choices tell the field of "My value" they sit above. */
export type FieldHandle = {
  /** A choice is being pressed: the field left now is left for it, and saves nothing yet. */
  hold(): void;
  /** A choice that hides the field was pressed: what was typed and not saved is dropped. */
  drop(): void;
};

/** A figure saved as it is typed: once the keys stop for a moment, and when the field is left. A
 *  value under `least` waits for the field to be left, being most likely on its way to a larger one;
 *  so does an emptied one there, most likely cleared to type another: saved, it would let go of
 *  the figure (a capacity back to its server, the field closed under the person's keys).
 *
 *  Under a control's choices (`handleRef`), a choice pressed wins over the figure being typed. Where a
 *  pressed button takes the focus (Chrome), the field is left for the choice before its click: that
 *  leaving, told by the choice's pointer going down or by the focus going to a choice of the same
 *  control, saves only after a typing pause, so that the click can drop it first. Where it does not
 *  (Safari), the field is never left, and the click drops the figure. */
export function FigureField({ id, value, parse, onSave, least, labelledBy, placeholder, inputMode = "decimal", handleRef }: {
  id?: string;
  value: number | null;
  parse(text: string): number | null | undefined;
  onSave(value: number | null): void;
  least?: number;
  labelledBy?: string;
  placeholder?: string;
  inputMode?: "decimal" | "numeric";
  handleRef?: React.RefObject<FieldHandle | null>;
}) {
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(value === null ? "" : String(value));
  const sent = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holding = useRef(false);
  const dropped = useRef(false);

  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      hold: () => {
        holding.current = true;
      },
      drop: () => {
        if (timer.current) clearTimeout(timer.current);
        dropped.current = true;
      },
    };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef]);

  // A value changed elsewhere (a notice's button) shows, unless the person is typing in it.
  useEffect(() => {
    sent.current = value;
    if (document.activeElement !== field.current) setText(value === null ? "" : String(value));
  }, [value]);

  function commit(typed: string, leaving: boolean) {
    if (dropped.current) return;
    const parsed = parse(typed);
    if (parsed === undefined || parsed === sent.current) return;
    if (!leaving && least !== undefined && (parsed === null || parsed < least)) return;
    sent.current = parsed;
    onSave(parsed);
  }

  // Gone from the page with a figure typed and not saved (the browser's back, which is Android's
  // back button, leaves no field): saved as leaving the field saves it. Nothing changed, nothing sent.
  const latest = useRef({ text, commit });
  useEffect(() => {
    latest.current = { text, commit };
  });
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    latest.current.commit(latest.current.text, true);
  }, []);

  return (
    <input
      ref={field}
      id={id}
      className="field"
      type="text"
      inputMode={inputMode}
      autoComplete="off"
      aria-labelledby={labelledBy}
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        const typed = e.target.value;
        setText(typed);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => commit(typed, false), TYPING_MS);
      }}
      onFocus={() => {
        holding.current = false;
      }}
      onBlur={(e) => {
        if (timer.current) clearTimeout(timer.current);
        const typed = e.target.value;
        const to = e.relatedTarget;
        const group = e.currentTarget.closest("[role=group]");
        const toChoice = to instanceof HTMLElement && to.hasAttribute("aria-pressed") && group !== null && to.closest("[role=group]") === group;
        if (handleRef && (holding.current || toChoice)) {
          // Left for a choice: saved after a pause, unless the choice drops it meanwhile.
          holding.current = false;
          timer.current = setTimeout(() => commit(typed, true), TYPING_MS);
          return;
        }
        commit(typed, true);
      }}
    />
  );
}
