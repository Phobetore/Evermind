"use client";

import { clsx } from "clsx";
import { Flame, MessagesSquare, Settings, UserRound, VenetianMask } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/i18n/useT";
import { LanguageSelect } from "./LanguageSelect";

const LINKS = [
  { href: "/", key: "nav.discover", icon: Flame, exact: true },
  { href: "/chat", key: "nav.conversations", icon: MessagesSquare },
  { href: "/personas", key: "nav.personas", icon: UserRound },
  { href: "/settings", key: "nav.settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const t = useT();
  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r border-ink-700 bg-ink-900/70 md:flex">
      <Link href="/" className="group flex items-center gap-2.5 px-5 pt-6 pb-7">
        <VenetianMask
          className="h-7 w-7 text-ember-400 transition-transform duration-300 group-hover:-rotate-12"
          strokeWidth={1.6}
        />
        <span className="font-display text-2xl font-semibold tracking-tight">Evermind</span>
      </Link>

      <nav className="flex flex-col gap-1 px-3">
        {LINKS.map(({ href, key, icon: Icon, exact }) => {
          const active = exact ? pathname === href : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-[0.95rem] transition-colors",
                active
                  ? "bg-ember-glow font-display font-semibold text-ember-300"
                  : "text-mist hover:bg-ink-800 hover:text-parchment",
              )}
            >
              <Icon className="h-[18px] w-[18px]" strokeWidth={active ? 2 : 1.7} />
              {t(key)}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-3 px-5 pb-5">
        <LanguageSelect />
        <p className="text-xs leading-relaxed text-mist-dim">{t("nav.tagline")}</p>
      </div>
    </aside>
  );
}
