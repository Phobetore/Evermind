"use client";

import CharacterAvatar from "@/components/ui/CharacterAvatar";
import type { Character, Conversation } from "@/types";

interface Props {
  character: Character;
  conversation: Conversation;
  activeProfile?: string;
}

/** Chat header bar showing character avatar, name, and conversation title. */
export default function ChatHeader({ character, conversation, activeProfile }: Props) {
  return (
    <div className="shrink-0 border-b border-border px-6 py-3 flex items-center gap-3">
      <CharacterAvatar name={character.name} size="sm" />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm">{character.name}</div>
        <div className="text-xs text-zinc-500">
          {conversation.title || "Conversation"}
        </div>
      </div>
      {activeProfile && (
        <span className="shrink-0 text-[10px] text-zinc-500 border border-border rounded-full px-2 py-0.5 capitalize">
          {activeProfile}
        </span>
      )}
    </div>
  );
}
