import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { LOCALE_STORAGE_KEY, type Locale } from "./config";
import { translate } from "./translate";

export type Translate = (key: string, vars?: Record<string, string | number>) => string;
type Ctx = { locale: Locale; setLocale: (l: Locale) => void; t: Translate };

const I18nContext = createContext<Ctx | null>(null);

export function I18nProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: React.ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // Not kept for next time, but the page still changes language now.
    }
    document.documentElement.lang = next;
  }, []);

  const t = useCallback<Translate>((key, vars) => translate(locale, key, vars), [locale]);

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): Ctx {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
