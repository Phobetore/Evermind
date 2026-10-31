export const LOCALES = ["en", "de", "es", "fr"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
/** Where the chosen language is kept, on this device. */
export const LOCALE_STORAGE_KEY = "evermind:locale";
/** Where it was kept before, when a server rendered the pages and needed to
 *  read it from each request. Only read now, so that nobody loses their choice
 *  with the update. */
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

/** First supported locale in a list of language tags such as an
 *  Accept-Language header or the browser's own languages, else the default. */
export function resolveLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  for (const part of acceptLanguage.split(",")) {
    const code = part.trim().split(";")[0].split("-")[0].toLowerCase();
    if (isLocale(code)) return code;
  }
  return DEFAULT_LOCALE;
}

/** The language to open in: the one chosen on this device, else the one the
 *  browser asks for. Reading storage can throw (private browsing, blocked site
 *  data, a sandboxed frame), and then it is as if nothing was chosen. */
export function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    /* nothing chosen, as far as we can tell */
  }
  try {
    const cookie = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(LOCALE_COOKIE + "="));
    const value = cookie?.slice(LOCALE_COOKIE.length + 1);
    if (isLocale(value)) return value;
  } catch {
    /* same as above */
  }
  return resolveLocale(navigator.languages?.join(",") || navigator.language);
}
