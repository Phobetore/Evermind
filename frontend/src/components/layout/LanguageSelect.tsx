"use client";

import { LOCALES, LOCALE_NAMES, type Locale } from "@/i18n/config";
import { useI18n } from "@/i18n/I18nProvider";

export function LanguageSelect() {
  const { locale, setLocale, t } = useI18n();
  return (
    <select
      aria-label={t("nav.language")}
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      className="field !py-1.5 text-sm"
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {LOCALE_NAMES[l]}
        </option>
      ))}
    </select>
  );
}
