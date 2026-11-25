import { clsx } from "clsx";
import { useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { useT } from "@/i18n/useT";
import { LINKS } from "./Sidebar";

/** Thumb-reach navigation for small screens. Hidden inside a conversation:
    there the keyboard and the input own the bottom of the screen. */
export function MobileNav() {
  const { pathname } = useLocation();
  const t = useT();
  const bar = useRef<HTMLDivElement>(null);
  const bare = useBare(bar, LINKS.map(({ key }) => t(key)).join(" "));
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-700 bg-ink-900 md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div ref={bar} className="mx-auto flex max-w-md">
        {LINKS.map(({ href, key, icon: Icon, exact }) => {
          const active = exact ? pathname === href : pathname.startsWith(href);
          return (
            <Link
              key={href}
              to={href}
              className={clsx(
                "flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2 transition-colors",
                // A finger's height still, in pixels as the icon is.
                bare && "min-h-[44px] justify-center",
                active ? "text-ember-300" : "text-mist hover:text-parchment",
              )}
            >
              <Icon className="h-5 w-5" strokeWidth={active ? 2.1 : 1.7} />
              {/* Where the four do not all fit whole (a narrow phone with very large text), the bar
                  shows its icons alone and each label is only heard: never cut, nor over the next. */}
              <span data-nav-label className={clsx("whitespace-nowrap font-display text-[0.62rem] font-medium tracking-wide", bare && "sr-only")}>
                {t(key)}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/** Whether a label of the bar is wider than its tab's share: measured on the text itself, which
 *  keeps its width while hidden, so the answer does not change with what it decides. */
function useBare(bar: React.RefObject<HTMLDivElement | null>, words: string): boolean {
  const [bare, setBare] = useState(false);
  useLayoutEffect(() => {
    const row = bar.current;
    if (!row) return;
    const check = () => {
      const labels = [...row.querySelectorAll<HTMLElement>("[data-nav-label]")];
      const room = row.clientWidth / Math.max(1, labels.length);
      const widest = Math.max(0, ...labels.map((label) => {
        const range = document.createRange();
        range.selectNodeContents(label);
        return range.getBoundingClientRect().width;
      }));
      setBare(widest > room + 0.5);
    };
    check();
    const watch = new ResizeObserver(check);
    watch.observe(row);
    // The label's own font arrives after the first measure, at other widths.
    void document.fonts?.ready.then(check);
    return () => watch.disconnect();
    // Measured again in another language, whose words have other widths.
  }, [bar, words]);
  return bare;
}
