"use client";

import { MobileNav } from "@/components/layout/MobileNav";
import { Sidebar } from "@/components/layout/Sidebar";
import { useT } from "@/i18n/useT";
import { clsx } from "clsx";
import { usePathname } from "next/navigation";

/** Desktop: fixed sidebar. Mobile: bottom tab bar, except inside a
    conversation (immersion + keyboard) and on the login gate. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const t = useT();
  const inConversation = /^\/chat\/[^/]+/.test(pathname);
  const inGate = pathname === "/login";
  const showMobileNav = !inConversation && !inGate;

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Off-screen until focused. Without it, reaching the page content from
          the keyboard means tabbing through the whole sidebar on every
          navigation. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50
                   focus:rounded-lg focus:bg-ink-900 focus:px-4 focus:py-2 focus:text-parchment"
      >
        {t("nav.skipToContent")}
      </a>
      <Sidebar />
      <main
        id="main"
        className={clsx(
          "min-w-0 flex-1 overflow-y-auto",
          showMobileNav && "pb-16 md:pb-0",
        )}
      >
        {children}
      </main>
      {showMobileNav && <MobileNav />}
    </div>
  );
}
