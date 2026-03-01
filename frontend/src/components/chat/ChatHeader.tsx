"use client";

import CharacterAvatar from "@/components/ui/CharacterAvatar";
import type { Character, Conversation, UserPersona } from "@/types";

interface Props {
  character: Character;
  conversation: Conversation;
  activeProfile?: string;
  persona?: UserPersona | null;
}

/** Cinematic chat header inspired by companion apps. */
export default function ChatHeader({ character, conversation, activeProfile, persona }: Props) {
  return (
    <div className="shrink-0 border-b border-border/70 px-6 py-4 bg-[radial-gradient(circle_at_top_right,rgba(139,92,246,0.25),transparent_45%)]">
      <div className="flex items-center gap-3">
        <CharacterAvatar name={character.name} size="sm" />
        <div className="flex-1 min-w-0">
          <div className="font-semibold tracking-wide">{character.name}</div>
          <div className="text-xs text-zinc-400 truncate">{conversation.title || "Session roleplay"}</div>
        </div>
        {persona && (
          <div className="hidden sm:flex items-center gap-1.5 border border-border rounded-full px-2 py-1 bg-surface/60">
            <span className="text-[10px] text-zinc-400">You:</span>
            <span className="text-[11px] text-zinc-200">{persona.name}</span>
          </div>
        )}
        {activeProfile && (
          <span className="text-[10px] text-violet-200 border border-violet-500/50 bg-violet-500/20 rounded-full px-2 py-1 capitalize">
            {activeProfile}
          </span>
        )}
      </div>
      {(character.tags?.length ?? 0) > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {character.tags.slice(0, 5).map((tag) => (
            <span key={tag} className="text-[10px] uppercase tracking-wider rounded-full border border-border/80 bg-surface px-2 py-1 text-zinc-300">
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
