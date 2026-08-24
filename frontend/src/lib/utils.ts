export function timeAgo(
  iso: string | null | undefined,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return t("time.justNow");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("time.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("time.daysAgo", { count: days });
  const months = Math.floor(days / 30);
  if (months < 12) return t("time.monthsAgo", { count: months });
  return t("time.yearsAgo", { count: Math.floor(months / 12) });
}

/** Resolve {{char}}/{{user}} macros for display (outside the chat flow,
    where the backend already substitutes them). */
export function previewMacros(text: string, charName: string, userName = "vous"): string {
  if (!text) return "";
  return text
    .replace(/\{\{\s*char\s*\}\}/gi, charName)
    .replace(/\{\{\s*user\s*\}\}/gi, userName);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** A v4 UUID, in every context Evermind actually gets opened in.
 *
 *  `crypto.randomUUID` only exists in a secure context, which means HTTPS or
 *  localhost. Reach the app over the network by address — `http://192.168.x.x`,
 *  the way anyone running it on one machine and using it from another does —
 *  and it is simply not there, so calling it threw and took the whole action
 *  down with it. `crypto.getRandomValues` has no such restriction, so the
 *  fallback is built from that rather than from Math.random. */
export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Copy to the clipboard, in every context Evermind gets opened in.
 *
 *  `navigator.clipboard` carries the same secure-context restriction as
 *  randomUUID above: reach the app over the network by address and the object
 *  is not there at all, so the copy button threw on the first property access
 *  and did nothing, without even the tick that says it worked. execCommand is
 *  deprecated but has no such restriction, and the click is the user gesture
 *  it asks for. */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // The object exists but the permission was refused. Fall through.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}
