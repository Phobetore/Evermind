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
export function previewMacros(text: string, charName: string, userName: string): string {
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

/** A v4 UUID. Not `crypto.randomUUID`, which a page over plain HTTP, as a phone opens it, lacks. */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether the focus is on the page itself, as when what held it has gone: a keyboard is then nowhere. */
export const nothingFocused = () => !document.activeElement || document.activeElement === document.body;

/** Whether it was copied. Not `navigator.clipboard`, which a page over plain HTTP lacks too. */
export function copyText(text: string): boolean {
  const active = document.activeElement as HTMLElement | null; // which selecting the text takes
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length); // iOS selects nothing otherwise
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    active?.focus();
  }
}

/** An address as the value of a CSS `url()`. Left bare, a parenthesis or a quote in it ends the
 *  function early and the picture silently does not show; line breaks are not allowed in a quoted string. */
export function cssUrl(url: string): string {
  return `url("${url.replace(/[\r\n]/g, "").replace(/[\\"]/g, "\\$&")}")`;
}
