import { cn } from "@/lib/utils";

interface Props {
  children: React.ReactNode;
  className?: string;
  as?: "div" | "button";
  onClick?: () => void;
}

/** Reusable surface card with consistent border and background. */
export default function Card({ children, className, as: Tag = "div", onClick }: Props) {
  return (
    <Tag
      className={cn(
        "rounded-2xl border border-border bg-surface/90 p-5 shadow-[0_8px_30px_rgba(0,0,0,0.24)] transition-all duration-200 hover:border-violet-500/30 hover:shadow-[0_12px_36px_rgba(76,29,149,0.3)]",
        className,
      )}
      onClick={onClick}
    >
      {children}
    </Tag>
  );
}
