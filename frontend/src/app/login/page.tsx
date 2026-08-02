"use client";

import { useT } from "@/i18n/useT";
import { KeyRound, Loader2, VenetianMask } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

function Gate() {
  const search = useSearchParams();
  const t = useT();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    if (!password || checking) return;
    setChecking(true);
    setError(null);
    try {
      const resp = await fetch("/gate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        setError(body.error ?? t("login.accessDenied"));
        setPassword("");
        setChecking(false);
        return;
      }
      // Full navigation so the middleware sees the fresh cookie.
      window.location.href = search.get("from") || "/";
    } catch {
      setError(t("login.serverUnreachable"));
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

export default function LoginPage() {
  return (
    <Suspense>
      <Gate />
    </Suspense>
  );
}
