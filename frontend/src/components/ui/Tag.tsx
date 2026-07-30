import { clsx } from "clsx";

export function Tag({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "ember" | "arcane";
  className?: string;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 font-display text-[0.7rem] font-medium tracking-wide",
        tone === "ember" && "border-ember-600/40 bg-ember-glow text-ember-300",
        tone === "arcane" && "border-arcane-500/40 bg-arcane-glow text-arcane-300",
        tone === "neutral" && "border-ink-600 bg-ink-800 text-mist",
        className,
      )}
    >
      {children}
    </span>
  );
}
