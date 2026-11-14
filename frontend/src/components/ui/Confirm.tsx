import { Modal } from "@/components/ui/Modal";
import { useT } from "@/i18n/useT";
import { oneQuestion, type Asked as AskedOf } from "@/lib/question";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";

type Options = { action: string; danger?: boolean };
type Ask = (question: string, options: Options) => Promise<boolean>;
type Asked = AskedOf<Options>;

/** How long the button that confirms hears nothing once the box is up. The box opens under the
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
  const opened = useRef(0);
  // After the layout effect of Modal, which opens the box and would otherwise take the focus
  // for the first thing in it: Enter on opening must never be a yes.
  useLayoutEffect(() => {
    opened.current = performance.now();
    cancel.current?.focus();
  }, []);

  return (
    <Modal title={question} role="alertdialog" onClose={() => settle(false)}>
      <div className="flex justify-end gap-2">
        <button ref={cancel} className="btn btn-ghost" onClick={() => settle(false)}>
          {t("common.cancel")}
        </button>
        <button
          className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
          // Only the yes waits: Cancel, Escape, the cross and a click outside are heard at once.
          onClick={() => performance.now() - opened.current >= DEAF_MS && settle(true)}
        >
          {action}
        </button>
      </div>
    </Modal>
  );
}
