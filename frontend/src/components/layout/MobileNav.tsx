"use client";

import { clsx } from "clsx";
import { Flame, MessagesSquare, Settings, UserRound } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/i18n/useT";

const LINKS = [
  { href: "/", key: "nav.discover", icon: Flame, exact: true },
  { href: "/chat", key: "nav.conversations", icon: MessagesSquare },
  { href: "/personas", key: "nav.personas", icon: UserRound },
  { href: "/settings", key: "nav.settings", icon: Settings },
];

/** Thumb-reach navigation for small screens. Hidden inside a conversation:
    there the keyboard and the input own the bottom of the screen. */
export function MobileNav() {
  const pathname = usePathname();
  const t = useT();
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-700 bg-ink-900 md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto flex max-w-md">
        {LINKS.map(({ href, key, icon: Icon, exact }) => {
          const active = exact ? pathname === href : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                "flex flex-1 flex-col items-center gap-0.5 py-2 transition-colors",
                active ? "text-ember-300" : "text-mist hover:text-parchment",
              )}
            >
              <Icon className="h-5 w-5" strokeWidth={active ? 2.1 : 1.7} />
              <span className="font-display text-[0.62rem] font-medium tracking-wide">
                {t(key)}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
