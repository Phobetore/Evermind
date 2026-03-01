import { cn } from "@/lib/utils";

interface Props {
  name: string;
  size?: "sm" | "md" | "lg";
  /** When true, renders a flat accent background (used for user avatars). */
  flat?: boolean;
  className?: string;
}

const sizeClasses = {
  sm: "h-8 w-8 text-sm",
  md: "h-10 w-10 text-lg",
  lg: "h-16 w-16 text-2xl",
} as const;

/** Gradient avatar badge showing the character's initial. */
export default function CharacterAvatar({ name, size = "md", flat, className }: Props) {
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-full font-medium shrink-0",
        flat ? "bg-violet-600" : "bg-gradient-to-br from-violet-600 to-purple-800",
        sizeClasses[size],
        className,
      )}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}
