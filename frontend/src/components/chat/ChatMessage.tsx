"use client";

import type { Message } from "@/types";
import Markdown from "react-markdown";

interface Props {
  message: Message;
  characterName: string;
  isLast?: boolean;
  onRegenerate?: () => void;
}

export default function ChatMessage({
  message,
  characterName,
  isLast,
  onRegenerate,
}: Props) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  if (isSystem) {
    return (
      <div className="text-center text-xs text-zinc-500 py-2">
        {message.content}
      </div>
    );
  }

  return (
    <div className={`group flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      {/* Avatar */}
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm ${
          isUser ? "bg-blue-600" : "bg-zinc-700"
        }`}
      >
        {isUser ? "U" : characterName.charAt(0).toUpperCase()}
      </div>

      {/* Bubble */}
      <div className="flex flex-col max-w-[75%]">
        <div
          className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
            isUser
              ? "bg-blue-600 text-white"
              : "bg-zinc-800 text-zinc-100"
          }`}
        >
          {isUser ? (
            message.content.split("\n").map((line, i) => (
              <p key={i} className={i > 0 ? "mt-2" : ""}>
                {line || "\u00A0"}
              </p>
            ))
          ) : (
            <Markdown
              components={{
                p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                strong: ({ children }) => (
                  <strong className="font-semibold">{children}</strong>
                ),
                em: ({ children }) => <em className="italic">{children}</em>,
                ul: ({ children }) => (
                  <ul className="list-disc ml-4 mb-2">{children}</ul>
                ),
                ol: ({ children }) => (
                  <ol className="list-decimal ml-4 mb-2">{children}</ol>
                ),
                code: ({ children }) => (
                  <code className="bg-zinc-700 px-1 py-0.5 rounded text-xs">
                    {children}
                  </code>
                ),
              }}
            >
              {message.content}
            </Markdown>
          )}
        </div>

        {/* Actions on last assistant message */}
        {!isUser && isLast && onRegenerate && (
          <div className="flex gap-2 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={onRegenerate}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              title="Regenerate"
            >
              ↻ Regenerate
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
