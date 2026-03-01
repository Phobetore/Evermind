"use client";

import CharacterAvatar from "@/components/ui/CharacterAvatar";
import type { Character, Conversation, UserPersona } from "@/types";

interface Props {
  character: Character;
  conversation: Conversation;
  activeProfile?: string;
  persona?: UserPersona | null;
}

/** Chat header bar showing character avatar, name, and conversation title. */
export default function ChatHeader({ character, conversation, activeProfile, persona }: Props) {
  return (
    <div className="shrink-0 border-b border-border px-6 py-3 flex items-center gap-3">
      <CharacterAvatar name={character.name} size="sm" />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm">{character.name}</div>
        <div className="text-xs text-zinc-500">
          {conversation.title || "Conversation"}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {persona && (
          <div className="flex items-center gap-1.5 border border-border rounded-full px-2 py-0.5">
            {persona.avatar_path ? (
              <img
                src={`/api/user_personas/${persona.id}/avatar/file`}
                alt={persona.name}
                className="h-4 w-4 rounded-full object-cover"
              />
            ) : (
              <div className="flex items-center justify-center h-4 w-4 rounded-full bg-violet-600 text-[8px] font-medium">
                {persona.name.charAt(0).toUpperCase()}
              </div>
            )}
            <span className="text-[10px] text-zinc-400">{persona.name}</span>
          </div>
        )}
        {activeProfile && (
          <span className="text-[10px] text-zinc-500 border border-border rounded-full px-2 py-0.5 capitalize">
            {activeProfile}
          </span>
        )}
      </div>
    </div>
  );
}
