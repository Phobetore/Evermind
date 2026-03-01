"use client";

import CharacterAvatar from "@/components/ui/CharacterAvatar";

interface Props {
  characterName: string;
  content: string | null;
  statusDetail: string | null;
}

/** Streaming response bubble with typing indicator. */
export default function StreamingBubble({ characterName, content, statusDetail }: Props) {
  if (content) {
    return (
      <div className="flex gap-3">
        <CharacterAvatar name={characterName} size="sm" />
        <div className="max-w-[75%] rounded-2xl bg-surface-light px-4 py-2.5 text-sm leading-relaxed text-zinc-100">
          {content}
          <span className="inline-block w-2 h-4 ml-0.5 bg-violet-400 animate-pulse" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 items-center">
      <CharacterAvatar name={characterName} size="sm" />
      <div className="flex items-center gap-2">
        <div className="flex gap-1">
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              className="w-2 h-2 rounded-full bg-violet-400 animate-bounce"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </div>
        {statusDetail && (
          <span className="text-xs text-zinc-500">{statusDetail}</span>
        )}
      </div>
    </div>
  );
}
