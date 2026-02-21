import type { Character } from "@/types";
import Link from "next/link";

interface Props {
  character: Character;
  onDelete?: (id: string) => void;
}

export default function CharacterCard({ character, onDelete }: Props) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 transition-colors hover:border-zinc-700">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          {/* Avatar placeholder */}
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-800 text-lg">
            {character.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <Link
              href={`/characters/${character.id}/edit`}
              className="font-medium hover:underline"
            >
              {character.name}
            </Link>
            {character.tags.length > 0 && (
              <div className="flex gap-1 mt-1 flex-wrap">
                {character.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-block rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        {onDelete && (
          <button
            onClick={() => onDelete(character.id)}
            className="text-zinc-500 hover:text-red-400 text-sm transition-colors"
            aria-label={`Delete ${character.name}`}
          >
            ✕
          </button>
        )}
      </div>
      {character.summary && (
        <p className="mt-3 text-sm text-zinc-400 line-clamp-2">
          {character.summary}
        </p>
      )}
    </div>
  );
}
