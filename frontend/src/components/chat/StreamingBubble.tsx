"use client";

import CharacterAvatar from "@/components/ui/CharacterAvatar";

interface Props {
  characterName: string;
  content: string | null;
  status: string | null;
  statusDetail: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  generating: "Generating",
  judging: "Judging",
  refining: "Refining",
  memory: "Memory",
};

/** Streaming response bubble with typing indicator and pipeline status. */
export default function StreamingBubble({ characterName, content, status, statusDetail }: Props) {
  const statusLabel = status ? (STATUS_LABELS[status] ?? status) : "Generating";

  if (content) {
    return (
      <div className="flex gap-3">
        <CharacterAvatar name={characterName} size="sm" />
        <div className="max-w-[75%] rounded-2xl bg-surface-light px-4 py-2.5 text-sm leading-relaxed text-zinc-100">
          {content}
          <span className="inline-block w-2 h-4 ml-0.5 bg-violet-400 animate-pulse" />
          {statusDetail && (
            <div className="mt-2 text-[10px] text-zinc-400">{statusDetail}</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 items-center">
      <CharacterAvatar name={characterName} size="sm" />
      <div className="flex items-center gap-2">
        <span className="rounded-full border border-violet-500/50 bg-violet-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-violet-200">
          {statusLabel}
        </span>
        <div className="flex gap-1">
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              className="w-2 h-2 rounded-full bg-violet-400 animate-bounce"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </div>
        {statusDetail && <span className="text-xs text-zinc-500">{statusDetail}</span>}
      </div>
    </div>
  );
}
