import { LOCALES, LOCALE_NAMES, type Locale } from "@/i18n/config";
import { useI18n } from "@/i18n/I18nProvider";

/** `compact` only where no phone sees it: iOS zooms into a box whose text is under 16px. */
export function LanguageSelect({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <select
      aria-label={t("nav.language")}
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      className={compact ? "field !py-1.5 text-sm" : "field"}
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {LOCALE_NAMES[l]}
        </option>
      ))}
    </select>
  );
}
