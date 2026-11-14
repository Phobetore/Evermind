import { Modal } from "@/components/ui/Modal";
import { useT } from "@/i18n/useT";
import { oneQuestion, type Asked as AskedOf } from "@/lib/question";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";

type Options = { action: string; danger?: boolean };
type Ask = (question: string, options: Options) => Promise<boolean>;
type Asked = AskedOf<Options>;

/** How long the button that confirms hears nothing once the box is drawn. The box opens under the
 *  pointer, and on some screens that button comes up where the one that opened it was: the second
 *  press of a double tap or a double click would be a yes to a question nobody has read. */
const DEAF_MS = 500;

const ConfirmContext = createContext<{ ask: Ask; drop: () => void } | null>(null);

/** Our own box in place of the browser's `confirm()`: a page in a sandboxed frame is not allowed
 *  to open that one, and it looks like nothing else here. */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [asked, setAsked] = useState<Asked | null>(null);
  const [questions] = useState(() => oneQuestion<Options>(setAsked));
  const value = useMemo(() => ({ ask: questions.ask, drop: questions.drop }), [questions]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {asked && <ConfirmBox {...asked} />}
    </ConfirmContext.Provider>
  );
}

/** Asks, and answers whether the person said yes. Anything but a yes (Cancel, Escape, the cross,
 *  a click outside, a question already open, a change of page) is a no. */
export function useConfirm(): Ask {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm needs a ConfirmProvider");
  return ctx.ask;
}

/** Placed inside the router, which the box sits above. A question about a page the person has
 *  left is a no, or a yes would run the handler of a page that is gone. Any move of the router
 *  counts: the back gesture, an address typed in, and the replace that a lock makes to send the
 *  person to the login, which the browser announces with no event at all. */
export function DropQuestionOnLeave() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("DropQuestionOnLeave needs a ConfirmProvider");
  const { drop } = ctx;
  // The location itself, not its key: an address typed in arrives with no state, and so with the
  // same "default" key as the page it replaces.
  const location = useLocation();
  useEffect(() => {
    drop();
  }, [location, drop]);
  return null;
}

function ConfirmBox({ question, action, danger, settle }: Asked) {
  const t = useT();
  const cancel = useRef<HTMLButtonElement>(null);
  // When the box was first drawn, on the clock of an event's own timeStamp; never, until it is.
  const drawn = useRef(Infinity);
  // After the layout effect of Modal, which opens the box and would otherwise take the focus
  // for the first thing in it: Enter on opening must never be a yes.
  useLayoutEffect(() => {
    cancel.current?.focus();
    // Counted from the frame that draws the box, not from its mount: a page busy as the box comes
    // up draws it late, and a press made before anyone could see it must not be a yes.
    const frame = requestAnimationFrame(() => {
      drawn.current = performance.now();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <Modal title={question} role="alertdialog" onClose={() => settle(false)}>
      {/* The word for what is confirmed can be a sentence, wider than a phone in some languages:
          the buttons go one under the other, then their words break, before either leaves the box. */}
      <div className="flex flex-wrap justify-end gap-2">
        <button ref={cancel} className="btn btn-ghost min-w-0 whitespace-normal break-words" onClick={() => settle(false)}>
          {t("common.cancel")}
        </button>
        <button
          className={`btn min-w-0 whitespace-normal break-words ${danger ? "btn-danger" : "btn-primary"}`}
          // Only the yes waits: Cancel, Escape, the cross and a click outside are heard at once. The
          // press's own time, not the time it is handled: on a busy page a press made inside the
          // half second is handled after it. A click no pointer made (detail 0: Enter or Space, or a
          // screen reader's) is heard at once: the deaf time guards against a pointer's second
          // press, and from the keyboard the focus on Cancel already does, since reaching this
          // button takes a move made after the box is there.
          onClick={(event) => (event.detail === 0 || event.timeStamp - drawn.current >= DEAF_MS) && settle(true)}
        >
          {action}
        </button>
      </div>
    </Modal>
  );
}
