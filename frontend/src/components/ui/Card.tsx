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
        "rounded-xl border border-border bg-surface p-5 transition-colors",
        className,
      )}
      onClick={onClick}
    >
      {children}
    </Tag>
  );
}
