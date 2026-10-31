import { data, onLocked } from "@/data";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Navigate, useLocation } from "react-router";

type AccessStatus = { enabled: boolean; authenticated: boolean };
type Ctx = {
  status: AccessStatus | null;
  /** Asks the server again, keeps the answer, and returns it. */
  refresh(): Promise<AccessStatus>;
  /** Whether this device has signed itself out and not been back in since. */
  signingOut: boolean;
  /** Signs this device out, or every device, and asks where that leaves it.
   *  Rejects, with the device still signed in as far as it knows, if the server
   *  could not be asked. */
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
  // Kept here, in memory, from the moment of signing out until the next time
  // this device is let in. It is what tells the gate that the person left on
  // purpose, and has no page to be taken back to.
  const [signingOut, setSigningOut] = useState(false);

  const refresh = useCallback(async () => {
    const fresh = data.access ? await data.access.status() : OPEN;
    setStatus(fresh);
    if (fresh.authenticated) setSigningOut(false);
    return fresh;
  }, []);

  const signOut = useCallback(
    async (everywhere: boolean) => {
      const access = data.access;
      if (!access) return;
      setSigningOut(true);
      try {
        await (everywhere ? access.logoutEverywhere() : access.logout());
        await refresh();
      } catch (error) {
        setSigningOut(false);
        throw error;
      }
    },
    [refresh],
  );

  useEffect(() => {
    // A server that cannot be asked opens onto the pages, which then say for
    // themselves that it cannot be reached. Waiting instead would leave a
    // blank screen; and if the password was what stood in the way, the first
    // refused call below still brings the login up.
    data.access?.status().then(setStatus, () => setStatus(OPEN));
  }, []);

  useEffect(
    () =>
      onLocked(() => {
        // Several calls are usually refused together (a page loads a few
        // things at once). Each lands here, and every one after the first
        // finds the state already locked and changes nothing, so the gate
        // redirects once, and not at all from the login itself.
        setStatus((current) =>
          current?.enabled && !current.authenticated ? current : LOCKED,
        );
      }),
    [],
  );

  const value = useMemo(
    () => ({ status, refresh, signingOut, signOut }),
    [status, refresh, signingOut, signOut],
  );
  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

export function useAccess(): Ctx {
  const ctx = useContext(AccessContext);
  if (!ctx) throw new Error("useAccess must be used within AccessProvider");
  return ctx;
}

/** Shows the pages only once this device may see them, and sends it to the
 *  login otherwise, remembering where it was going, unless it has just signed
 *  out: then it was going nowhere. A session that ends while a page is open
 *  lands here too, through `onLocked` above, instead of leaving that page to
 *  show an error for every call it makes. */
export function AccessGate({ children }: { children: React.ReactNode }) {
  const { status, signingOut } = useAccess();
  const { pathname, search } = useLocation();
  if (status === null) return null;
  if (status.enabled && !status.authenticated && pathname !== "/login") {
    const back = signingOut ? "" : "?from=" + encodeURIComponent(pathname + search);
    return <Navigate to={"/login" + back} replace />;
  }
  return <>{children}</>;
}
