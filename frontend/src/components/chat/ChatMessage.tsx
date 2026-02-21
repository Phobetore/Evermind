"use client";

import type { Message } from "@/types";

interface Props {
  message: Message;
  characterName: string;
}

export default function ChatMessage({ message, characterName }: Props) {
  const isUser = message.role === "user";

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      {/* Avatar */}
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm ${
          isUser ? "bg-blue-600" : "bg-zinc-700"
        }`}
      >
        {isUser ? "U" : characterName.charAt(0).toUpperCase()}
      </div>

      {/* Bubble */}
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? "bg-blue-600 text-white"
            : "bg-zinc-800 text-zinc-100"
        }`}
      >
        {message.content.split("\n").map((line, i) => (
          <p key={i} className={i > 0 ? "mt-2" : ""}>
            {line || "\u00A0"}
          </p>
        ))}
      </div>
    </div>
  );
}
