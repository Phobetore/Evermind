import "@fontsource-variable/fraunces/full.css";
import "@fontsource-variable/newsreader/index.css";
import "@fontsource-variable/newsreader/wght-italic.css";
import "./styles.css";

import { AccessProvider } from "@/components/layout/Access";
import { ConfirmProvider } from "@/components/ui/Confirm";
import { data } from "@/data";
import { initialLocale } from "@/i18n/config";
import { I18nProvider, type Translate } from "@/i18n/I18nProvider";
import { translate } from "@/i18n/translate";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { router } from "./router";
import { start } from "./start";
import { StartFailure } from "./StartFailure";

const root = createRoot(document.getElementById("root")!);

function render() {
  const locale = initialLocale();
  document.documentElement.lang = locale;
  root.render(
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
}

function renderFailure(error: unknown) {
  const locale = initialLocale();
  const t: Translate = (key, vars) => translate(locale, key, vars);
  document.documentElement.lang = locale;
  root.render(
    <StrictMode>
      <StartFailure error={error} t={t} />
    </StrictMode>,
  );
}

void start(data.device, render, renderFailure);
