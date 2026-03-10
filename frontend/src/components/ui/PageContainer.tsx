import { cn } from "@/lib/utils";

interface Props {
  children: React.ReactNode;
  /** Override the default max-width (max-w-4xl). */
  wide?: boolean;
  className?: string;
}

/** Consistent page wrapper with padding and centered max-width. */
export default function PageContainer({ children, wide, className }: Props) {
  return (
    <div
      className={cn(
        "mx-auto px-4 py-6 sm:px-6 sm:py-8",
        wide ? "max-w-5xl" : "max-w-4xl",
        className,
      )}
    >
      {children}
    </div>
  );
}
