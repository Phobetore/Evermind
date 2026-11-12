import { Modal } from "@/components/ui/Modal";
import { useT } from "@/i18n/useT";
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";

type Options = { action: string; danger?: boolean };
type Ask = (question: string, options: Options) => Promise<boolean>;
type Asked = Options & { question: string; settle: (answer: boolean) => void };

const ConfirmContext = createContext<Ask | null>(null);

/** Our own box in place of the browser's `confirm()`: a page in a sandboxed frame is not allowed
 *  to open that one, and it looks like nothing else here. */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [asked, setAsked] = useState<Asked | null>(null);
  // Read at once, not through state: two clicks in the same frame must not open two questions.
  const open = useRef(false);

  const ask = useCallback<Ask>((question, options) => {
    if (open.current) return Promise.resolve(false);
    open.current = true;
    return new Promise<boolean>((resolve) => {
      setAsked({
        question,
        ...options,
        settle: (answer) => {
          if (!open.current) return;
          open.current = false;
          setAsked(null);
          resolve(answer);
        },
      });
    });
  }, []);

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {asked && <ConfirmBox {...asked} />}
    </ConfirmContext.Provider>
  );
}

/** Asks, and answers whether the person said yes. Anything but a yes (Cancel, Escape, the cross,
 *  a click outside, a question already open) is a no. */
export function useConfirm(): Ask {
  const ask = useContext(ConfirmContext);
  if (!ask) throw new Error("useConfirm needs a ConfirmProvider");
  return ask;
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
