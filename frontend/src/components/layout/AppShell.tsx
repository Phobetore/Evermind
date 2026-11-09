import { MobileNav } from "@/components/layout/MobileNav";
import { Sidebar } from "@/components/layout/Sidebar";
import { useT } from "@/i18n/useT";
import { clsx } from "clsx";
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

/** Desktop: fixed sidebar. Mobile: bottom tab bar, except inside a
    conversation (immersion + keyboard) and on the login gate. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const t = useT();
  const mainRef = useRef<HTMLElement>(null);
  const inConversation = /^\/chat\/[^/]+/.test(pathname);
  const inGate = pathname === "/login";
  const showMobileNav = !inConversation && !inGate;

  // The page scrolls inside <main>, not the window, and <main> stays in place
  // from one page to the next: without this, a page opened from far down a
  // long list would open just as far down.
  useEffect(() => {
    mainRef.current?.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Off-screen until focused, so the keyboard need not cross the sidebar. The route is after "#",
          so following the link would leave the page: it moves the focus itself. */}
      <a
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50
                   focus:rounded-lg focus:bg-ink-900 focus:px-4 focus:py-2 focus:text-parchment"
      >
        {t("nav.skipToContent")}
      </a>
      <Sidebar />
      <main
        id="main"
        ref={mainRef}
        // Focusable from the skip link only, not a stop of its own when tabbing.
        tabIndex={-1}
        className={clsx(
          "min-w-0 flex-1 overflow-y-auto outline-none",
          showMobileNav && "pb-16 md:pb-0",
        )}
      >
        {children}
      </main>
      {showMobileNav && <MobileNav />}
    </div>
  );
}
