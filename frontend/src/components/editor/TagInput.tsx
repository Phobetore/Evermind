"use client";

import { useT } from "@/i18n/useT";
import { X } from "lucide-react";
import { useState } from "react";

export function TagInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}) {
  const t = useT();
  const effectivePlaceholder = placeholder ?? t("ui.tagInput.placeholder");
  const [draft, setDraft] = useState("");

  function commit() {
    const tag = draft.trim();
    if (tag && !value.includes(tag)) onChange([...value, tag]);
    setDraft("");
  }

  return (
    <div className="field flex flex-wrap items-center gap-1.5 py-2">
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full border border-ink-600 bg-ink-800 px-2.5 py-0.5 font-display text-xs text-parchment-dim"
        >
          {tag}
          <button
            type="button"
            onClick={() => onChange(value.filter((tagValue) => tagValue !== tag))}
            className="text-mist-dim hover:text-blood"
            aria-label={t("ui.tagInput.removeAriaLabel", { tag })}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={commit}
        placeholder={value.length === 0 ? effectivePlaceholder : ""}
        className="min-w-32 flex-1 bg-transparent text-sm outline-none placeholder:text-mist-dim"
      />
    </div>
  );
}
