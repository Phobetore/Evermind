import type { Metadata, Viewport } from "next";
import { Fraunces, Newsreader } from "next/font/google";
import { AppShell } from "@/components/layout/AppShell";
import "./globals.css";
import { cookies, headers } from "next/headers";
import { I18nProvider } from "@/i18n/I18nProvider";
import { LOCALE_COOKIE, isLocale, resolveLocale, type Locale } from "@/i18n/config";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  axes: ["SOFT", "WONK", "opsz"],
});

const newsreader = Newsreader({
  subsets: ["latin"],
  variable: "--font-newsreader",
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "Evermind",
  description:
    "Immersive roleplay with your own characters and scenarios, powered by the AI model of your choice, running at home.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Lets env(safe-area-inset-*) work on notched phones (chat input, nav bar).
  viewportFit: "cover",
  themeColor: "#0f0d12",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieLocale = (await cookies()).get(LOCALE_COOKIE)?.value;
  let locale: Locale;
  if (isLocale(cookieLocale)) {
    locale = cookieLocale;
  } else {
    locale = resolveLocale((await headers()).get("accept-language"));
  }
  return (
    <html lang={locale} className={`${fraunces.variable} ${newsreader.variable}`}>
      <body>
        <I18nProvider initialLocale={locale}>
          <AppShell>{children}</AppShell>
        </I18nProvider>
      </body>
    </html>
  );
}
