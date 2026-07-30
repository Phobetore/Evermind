import { clsx } from "clsx";

const PALETTE = [
  ["#3d2c52", "#b18ae0"],
  ["#4f2f2a", "#e0a184"],
  ["#2a3e46", "#84c5d6"],
  ["#45391f", "#e2c26b"],
  ["#2f4430", "#93c98a"],
  ["#4a2839", "#dc8ab4"],
];

function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function Avatar({
  name,
  src,
  className,
  rounded = "rounded-full",
}: {
  name: string;
  src?: string | null;
  className?: string;
  rounded?: string;
}) {
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name}
        className={clsx("object-cover", rounded, className)}
        draggable={false}
      />
    );
  }
  const [bg, fg] = PALETTE[hashName(name || "?") % PALETTE.length];
  return (
    <div
      className={clsx("flex select-none items-center justify-center", rounded, className)}
      style={{ background: `linear-gradient(135deg, ${bg}, ${bg}cc)`, color: fg }}
    >
      <span className="font-display text-[0.9em] font-semibold">
        {(name || "?").trim().charAt(0).toUpperCase()}
      </span>
    </div>
  );
}
