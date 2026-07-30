"use client";

import { MobileNav } from "@/components/layout/MobileNav";
import { Sidebar } from "@/components/layout/Sidebar";
import { clsx } from "clsx";
import { usePathname } from "next/navigation";

/** Desktop: fixed sidebar. Mobile: bottom tab bar, except inside a
    conversation (immersion + keyboard) and on the login gate. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const inConversation = /^\/chat\/[^/]+/.test(pathname);
  const inGate = pathname === "/login";
  const showMobileNav = !inConversation && !inGate;

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar />
      <main
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
