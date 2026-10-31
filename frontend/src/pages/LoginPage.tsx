import { useAccess } from "@/components/layout/Access";
import { data, DataError } from "@/data";
import { useT } from "@/i18n/useT";
import { safeFrom } from "@/lib/safeFrom";
import { KeyRound, Loader2, VenetianMask } from "lucide-react";
import { useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";

export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { status, refresh } = useAccess();
  const t = useT();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // Only ever a page of this app: the address can be written by anyone.
  const from = safeFrom(params.get("from"));

  // Nothing to unlock: no password is set, or this device is already in.
  if (!data.access || (status && (!status.enabled || status.authenticated))) {
    return <Navigate to={from} replace />;
  }
  const access = data.access;

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    if (!password || checking) return;
    setChecking(true);
    setError(null);
    try {
      await access.login(password);
      const fresh = await refresh();
      if (fresh.enabled && !fresh.authenticated) {
        // The server took the password and this browser did not keep the
        // session it gave back, as phones with strict cookie settings do for
        // an address that is not https. Going on would land on this very
        // page again, silently.
        setError(t("login.cookieRefused"));
        setChecking(false);
        return;
      }
      navigate(from, { replace: true });
    } catch (e) {
      if (e instanceof DataError && e.kind === "wrong_password") {
        setError(t("login.accessDenied"));
        setPassword("");
      } else if (e instanceof DataError && e.kind === "rate_limited") {
        // The server says how long in seconds; a minute is what people read.
        const minutes = Math.max(1, Math.ceil((e.retryAfter ?? 60) / 60));
        setError(t("login.tooManyAttempts", { minutes }));
      } else if (e instanceof DataError) {
        setError(e.message);
      } else {
        setError(t("login.serverUnreachable"));
      }
      setChecking(false);
    }
  }

  return (
    // Fixed overlay: the root layout renders the sidebar behind this page.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950 px-6">
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          backgroundImage:
            "radial-gradient(700px 420px at 50% 12%, rgba(226,154,62,0.10), transparent 62%)," +
            "radial-gradient(620px 460px at 50% 100%, rgba(139,102,179,0.09), transparent 58%)",
        }}
      />

      <div className="relative w-full max-w-sm animate-rise">
        <div className="mb-9 flex flex-col items-center text-center">
          <VenetianMask className="mb-4 h-11 w-11 text-ember-400" strokeWidth={1.4} />
          <h1 className="font-display text-4xl font-semibold tracking-tight">Evermind</h1>
          <p className="mt-2 text-sm leading-relaxed text-mist">{t("login.tagline")}</p>
        </div>

        <form onSubmit={unlock} className="panel p-6">
          <label className="ui-label mb-2 block" htmlFor="gate-password">
            {t("login.passwordLabel")}
          </label>
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mist-dim" />
            <input
              id="gate-password"
              type="password"
              className="field pl-9"
              value={password}
              autoFocus
              autoComplete="current-password"
              placeholder="••••••••"
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
            />
          </div>

          {error && (
            <p className="mt-3 rounded-lg border border-blood/40 bg-blood/10 px-3 py-2 text-sm text-blood animate-fade">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="btn btn-primary mt-4 w-full"
            disabled={!password || checking}
          >
            {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : t("login.enterButton")}
          </button>
        </form>

        <p className="mt-5 text-center text-[0.7rem] leading-relaxed text-mist-dim">
          {t("login.localAccessNote")}
        </p>
      </div>
    </div>
  );
}
