"use client";

import { Sparkles } from "lucide-react";
import { useState } from "react";

interface Props {
  onSend: (message: string) => void;
  disabled?: boolean;
}

const QUICK_PROMPTS = [
  "Continue with a more intense scene.",
  "Add sensory details and body language.",
  "Keep strict continuity with previous promises.",
];

export default function ChatInput({ onSend, disabled }: Props) {
  const [value, setValue] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {QUICK_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            disabled={disabled}
            onClick={() => setValue(prompt)}
            className="shrink-0 rounded-full border border-border bg-surface px-3 py-1 text-[11px] text-zinc-300 hover:border-violet-500/60 hover:text-zinc-100"
          >
            <Sparkles size={11} className="inline mr-1" />
            {prompt}
          </button>
        ))}
      </div>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder="Write your next turn..."
          rows={2}
          className="input flex-1 resize-none min-h-[58px] max-h-[180px]"
        />
        <button
          type="submit"
          disabled={disabled || !value.trim()}
          className="rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-500 disabled:opacity-50 shrink-0"
        >
          Send
        </button>
      </form>
    </div>
  );
}
