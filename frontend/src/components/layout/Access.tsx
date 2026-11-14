import { data, onLocked } from "@/data";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { parsePath, useLocation, useNavigate } from "react-router";

type AccessStatus = { enabled: boolean; authenticated: boolean };
type Ctx = {
  status: AccessStatus | null;
  /** Asks the server again, keeps the answer, and returns it. */
  refresh(): Promise<AccessStatus>;
  /** Signs this device out, or every device. Rejects if the server did not. */
  signOut(everywhere: boolean): Promise<void>;
};

/** What an edition without an access password always answers. */
const OPEN: AccessStatus = { enabled: false, authenticated: true };
/** What the server says, by refusing a call, once this device's session has
 *  ended: signed out from another device, or the password changed. */
const LOCKED: AccessStatus = { enabled: true, authenticated: false };

const AccessContext = createContext<Ctx | null>(null);

/** Whether the access password is set, and whether this device is past it.
 *  `status` is null until the server has said. */
export function AccessProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AccessStatus | null>(data.access ? null : OPEN);

  const refresh = useCallback(async () => {
    const fresh = data.access ? await data.access.status() : OPEN;
    setStatus(fresh);
    return fresh;
  }, []);

  const signOut = useCallback(async (everywhere: boolean) => {
    const access = data.access;
    if (!access) return;
    await (everywhere ? access.logoutEverywhere() : access.logout());
    setStatus(LOCKED);
  }, []);

  useEffect(() => {
    // A server that cannot be asked opens onto the pages, which say so themselves, not a blank
    // screen; a password in the way still brings the login up at the first refused call.
    data.access?.status().then(setStatus, () => setStatus(OPEN));
  }, []);

  useEffect(() => onLocked(() => setStatus(LOCKED)), []);

  const value = useMemo(() => ({ status, refresh, signOut }), [status, refresh, signOut]);
  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

export function useAccess(): Ctx {
  const ctx = useContext(AccessContext);
  if (!ctx) throw new Error("useAccess must be used within AccessProvider");
  return ctx;
}

/** Shows the pages only once this device may see them, and sends it to the
 *  login otherwise, remembering where it was going. A session that ends while
 *  a page is open, signed out here or elsewhere, lands here too.
 *
 *  Where it was going is read from the address at the moment it is sent, not
 *  from the page last drawn: a link followed as the session ends changes the
 *  address before the router has drawn the new page, and the page left behind
 *  would otherwise be remembered in its place. */
export function AccessGate({ children }: { children: React.ReactNode }) {
  const { status } = useAccess();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const locked = status !== null && status.enabled && !status.authenticated;

  useEffect(() => {
    if (!locked) return;
    const asked = parsePath(window.location.hash.slice(1));
    const path = (asked.pathname || "/") + (asked.search ?? "");
    if (asked.pathname === "/login") return;
    navigate("/login?from=" + encodeURIComponent(path), { replace: true });
  }, [locked, pathname, search, navigate]);

  if (status === null) return null;
  if (locked && pathname !== "/login") return null;
  return <>{children}</>;
}
