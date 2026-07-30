import type { LucideIcon } from "lucide-react";

export function EmptyState({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center animate-fade">
      <div className="rounded-2xl border border-ink-700 bg-ink-850 p-4">
        <Icon className="h-8 w-8 text-ember-500/70" strokeWidth={1.4} />
      </div>
      <h3 className="font-display text-lg font-semibold text-parchment-dim">{title}</h3>
      <div className="max-w-sm text-sm leading-relaxed text-mist">{children}</div>
    </div>
  );
}
