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
import { describeError } from "@/lib/errors";
import { RotateCw } from "lucide-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { router } from "./router";
import { start } from "./start";

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

/** A page of its own, with nothing of the application around it: the application cannot be drawn. */
function renderFailure(error: unknown) {
  const locale = initialLocale();
  const t: Translate = (key, vars) => translate(locale, key, vars);
  document.documentElement.lang = locale;
  root.render(
    <StrictMode>
      <div role="alert" className="flex flex-col items-center gap-5 px-6 py-20 text-center">
        <p className="max-w-sm leading-relaxed text-mist">{describeError(error, t)}</p>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>
          <RotateCw className="h-4 w-4" />
          {t("common.reload")}
        </button>
      </div>
    </StrictMode>,
  );
}

void start(data.device, render, renderFailure);
