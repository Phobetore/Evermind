"use client";

import AppShell from "@/components/layout/AppShell";
import { StreamingProvider } from "@/contexts/StreamingContext";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <StreamingProvider>
      <AppShell>{children}</AppShell>
    </StreamingProvider>
  );
}
