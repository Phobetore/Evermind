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
        "p-6 mx-auto",
        wide ? "max-w-5xl" : "max-w-4xl",
        className,
      )}
    >
      {children}
    </div>
  );
}
