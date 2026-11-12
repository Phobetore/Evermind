import "@fontsource-variable/fraunces/full.css";
import "@fontsource-variable/newsreader/index.css";
import "@fontsource-variable/newsreader/wght-italic.css";
import "./styles.css";

import { AccessProvider } from "@/components/layout/Access";
import { ConfirmProvider } from "@/components/ui/Confirm";
import { initialLocale } from "@/i18n/config";
import { I18nProvider } from "@/i18n/I18nProvider";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { router } from "./router";

const locale = initialLocale();
document.documentElement.lang = locale;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider initialLocale={locale}>
      <ConfirmProvider>
        <AccessProvider>
          <RouterProvider router={router} />
        </AccessProvider>
      </ConfirmProvider>
    </I18nProvider>
  </StrictMode>,
);
