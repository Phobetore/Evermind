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
  loading,
  decoding,
  onLoad,
  alt,
  wideSrc,
}: {
  name: string;
  src?: string | null;
  className?: string;
  rounded?: string;
  loading?: "lazy" | "eager";
  decoding?: "async" | "auto";
  onLoad?: () => void;
  /** The name when left out; "" where the name is already said beside the picture. */
  alt?: string;
  /** The picture from sm up, where `src` would be drawn larger than it was made. */
  wideSrc?: string;
}) {
  if (src) {
    const img = (
      <img
        src={src}
        alt={alt ?? name}
        loading={loading}
        decoding={decoding}
        onLoad={onLoad}
        className={clsx("object-cover", rounded, className)}
        draggable={false}
      />
    );
    if (!wideSrc) return img;
    return (
      <picture>
        <source media="(min-width: 40rem)" srcSet={wideSrc} />
        {img}
      </picture>
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
