import { data } from "@/data";

export const LOCALES = ["en", "de", "es", "fr"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
/** Where the chosen language is kept, on this device. */
export const LOCALE_STORAGE_KEY = "evermind:locale";
/** The language chosen in earlier versions was kept in this cookie. It is
 *  only read now, so that nobody loses their choice with the update. */
export const LOCALE_COOKIE = "evermind_locale";
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
};

export function isLocale(value: string | undefined | null): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}

/** First supported locale in a list of language tags, if there is one. */
function supportedLocale(tags: string): Locale | null {
  for (const part of tags.split(",")) {
    const code = part.trim().split(";")[0].split("-")[0].toLowerCase();
    if (isLocale(code)) return code;
  }
  return null;
}

/** First supported locale in a list of language tags such as an
 *  Accept-Language header or the browser's own languages, else the default. */
export function resolveLocale(acceptLanguage: string | null | undefined): Locale {
  return (acceptLanguage && supportedLocale(acceptLanguage)) || DEFAULT_LOCALE;
}

/** The language to open in: the one chosen on this device, else the one the
 *  host suggests, else the one the browser asks for. A device that keeps
 *  nothing reads as if nothing was chosen. */
export function initialLocale(): Locale {
  const stored = data.device.get(LOCALE_STORAGE_KEY);
  if (isLocale(stored)) return stored;
  // The host's word is taken as it comes: only the four languages here are kept of it.
  const suggested = data.device.suggestedLocale && supportedLocale(data.device.suggestedLocale);
  if (suggested) return suggested;
  try {
    const cookie = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(LOCALE_COOKIE + "="));
    const value = cookie?.slice(LOCALE_COOKIE.length + 1);
    if (isLocale(value)) return value;
  } catch {
    /* a cookie that cannot be read is no choice */
  }
  return resolveLocale(navigator.languages?.join(",") || navigator.language);
}
