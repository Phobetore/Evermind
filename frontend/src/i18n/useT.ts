"use client";

import { useI18n } from "./I18nProvider";

/** Shorthand for components that only need the translate function. */
export function useT() {
  return useI18n().t;
}
