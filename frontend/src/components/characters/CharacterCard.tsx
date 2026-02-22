import type { Character } from "@/types";
import Link from "next/link";
import { Brain, Download, X } from "lucide-react";

interface Props {
  character: Character;
  onDelete?: (id: string) => void;
  onExport?: (id: string) => void;
}

export default function CharacterCard({ character, onDelete, onExport }: Props) {
  return (
    <div className="rounded-xl border border-[#2a2440] bg-[#14111f] p-5 transition-colors hover:border-violet-500/30">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          {/* Avatar placeholder */}
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-violet-600 to-purple-800 text-lg font-medium">
            {character.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <Link
              href={`/characters/${character.id}/edit`}
              className="font-medium hover:text-violet-300 transition-colors"
            >
              {character.name}
            </Link>
            {character.tags.length > 0 && (
              <div className="flex gap-1 mt-1 flex-wrap">
                {character.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-block rounded-full bg-[#1e1a2e] px-2 py-0.5 text-xs text-zinc-400"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/characters/${character.id}/memories`}
            className="text-zinc-500 hover:text-violet-400 text-sm transition-colors"
            title="Memory Inspector"
          >
            <Brain size={16} />
          </Link>
          {onExport && (
            <button
              onClick={() => onExport(character.id)}
              className="text-zinc-500 hover:text-green-400 text-sm transition-colors"
              aria-label={`Export ${character.name}`}
              title="Export"
            >
              <Download size={16} />
            </button>
          )}
          {onDelete && (
            <button
              onClick={() => onDelete(character.id)}
              className="text-zinc-500 hover:text-red-400 text-sm transition-colors"
              aria-label={`Delete ${character.name}`}
              title="Delete"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>
      {character.summary && (
        <p className="mt-3 text-sm text-zinc-400 line-clamp-2">
          {character.summary}
        </p>
      )}
    </div>
  );
}
