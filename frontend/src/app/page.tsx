import Link from "next/link";

export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center relative overflow-hidden">
      {/* Subtle radial glow */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(139,92,246,0.08)_0%,_transparent_70%)]" />

      <main className="flex flex-col items-center gap-8 text-center px-8 relative z-10">
        <div className="flex flex-col items-center gap-3">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-600 to-purple-800 flex items-center justify-center shadow-lg shadow-violet-900/30">
            <span className="text-2xl">✦</span>
          </div>
          <h1 className="text-5xl font-bold tracking-tight bg-gradient-to-r from-violet-300 to-purple-400 bg-clip-text text-transparent">
            Evermind
          </h1>
        </div>
        <p className="max-w-md text-lg text-zinc-400">
          AI companion — multi-character, long-term memory, text only.
        </p>
        <div className="flex gap-4">
          <Link
            href="/characters"
            className="rounded-lg bg-violet-600 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-violet-500 shadow-lg shadow-violet-900/20"
          >
            Get Started
          </Link>
          <Link
            href="/chat"
            className="rounded-lg border border-violet-500/30 px-6 py-3 text-sm font-medium text-violet-300 transition-colors hover:bg-violet-500/10"
          >
            Open Chat
          </Link>
        </div>
      </main>
    </div>
  );
}
