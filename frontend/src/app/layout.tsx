import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Evermind",
  description: "AI companion — multi-character, long-term memory, text only.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="antialiased bg-zinc-950 text-zinc-100 min-h-screen" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
