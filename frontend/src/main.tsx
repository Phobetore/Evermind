import "@fontsource-variable/fraunces/full.css";
import "@fontsource-variable/newsreader/index.css";
import "@fontsource-variable/newsreader/wght-italic.css";
import "./styles.css";

import { AccessProvider } from "@/components/layout/Access";
import { initialLocale } from "@/i18n/config";
import { I18nProvider } from "@/i18n/I18nProvider";
import { logRouteError } from "@/lib/lazyPage";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { router } from "./router";

const locale = initialLocale();
document.documentElement.lang = locale;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider initialLocale={locale}>
      <AccessProvider>
        <RouterProvider router={router} onError={logRouteError} />
      </AccessProvider>
    </I18nProvider>
  </StrictMode>,
);
