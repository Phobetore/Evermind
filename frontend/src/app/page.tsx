export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <main className="flex flex-col items-center gap-8 text-center px-8">
        <h1 className="text-5xl font-bold tracking-tight">
          Evermind
        </h1>
        <p className="max-w-md text-lg text-zinc-400">
          AI companion — multi-character, long-term memory, text only.
        </p>
        <div className="flex gap-4">
          <a
            href="/characters"
            className="rounded-lg bg-zinc-100 px-6 py-3 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200"
          >
            Characters
          </a>
        </div>
      </main>
    </div>
  );
}
