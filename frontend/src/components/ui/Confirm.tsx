import { Modal } from "@/components/ui/Modal";
import { useT } from "@/i18n/useT";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";

type Options = { action: string; danger?: boolean };
type Ask = (question: string, options: Options) => Promise<boolean>;
type Asked = Options & { question: string; settle: (answer: boolean) => void };

const ConfirmContext = createContext<{ ask: Ask; drop: () => void } | null>(null);

/** Our own box in place of the browser's `confirm()`: a page in a sandboxed frame is not allowed
 *  to open that one, and it looks like nothing else here. */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [asked, setAsked] = useState<Asked | null>(null);
  // Read at once, not through state: two clicks in the same frame must not open two questions.
  const open = useRef(false);
  const current = useRef<Asked | null>(null);

  const ask = useCallback<Ask>((question, options) => {
    if (open.current) return Promise.resolve(false);
    open.current = true;
    return new Promise<boolean>((resolve) => {
      const next: Asked = {
        question,
        ...options,
        settle: (answer) => {
          if (!open.current) return;
          open.current = false;
          current.current = null;
          setAsked(null);
          resolve(answer);
        },
      };
      current.current = next;
      setAsked(next);
    });
  }, []);

  const drop = useCallback(() => current.current?.settle(false), []);
  const value = useMemo(() => ({ ask, drop }), [ask, drop]);

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
  // After the layout effect of Modal, which opens the box and would otherwise take the focus
  // for the first thing in it: Enter on opening must never be a yes.
  useLayoutEffect(() => {
    cancel.current?.focus();
  }, []);

  return (
    <Modal title={question} role="alertdialog" onClose={() => settle(false)}>
      <div className="flex justify-end gap-2">
        <button ref={cancel} className="btn btn-ghost" onClick={() => settle(false)}>
          {t("common.cancel")}
        </button>
        <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={() => settle(true)}>
          {action}
        </button>
      </div>
    </Modal>
  );
}
