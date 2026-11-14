// The names the form gives the fields of a card, which the assistant, the re-read banner and the
// import report use for them too.

import type { AssistField } from "@/data";
import type { Kind } from "@/types";

export const KIND_COPY: Record<Kind, Record<string, { labelKey: string; hintKey: string }>> = {
  character: {
    description: {
      labelKey: "characters.form.descriptionLabel",
      hintKey: "characters.form.descriptionHint",
    },
    personality: { labelKey: "characters.form.personalityLabel", hintKey: "characters.form.personalityHint" },
    scenario: { labelKey: "characters.form.startingSituationLabel", hintKey: "characters.form.startingSituationHint" },
    greeting: { labelKey: "characters.form.greetingLabel", hintKey: "characters.form.greetingHint" },
  },
  scenario: {
    description: {
      labelKey: "characters.form.worldLabel",
      hintKey: "characters.form.worldHint",
    },
    personality: { labelKey: "characters.form.toneLabel", hintKey: "characters.form.toneHint" },
    scenario: { labelKey: "characters.form.playerRoleLabel", hintKey: "characters.form.playerRoleHint" },
    greeting: { labelKey: "characters.form.openingSceneLabel", hintKey: "characters.form.openingSceneHint" },
  },
};

/** The name the form gives a field of the card, which the assistant's words use for it. */
export function labelKey(field: AssistField, kind: Kind): string {
  switch (field) {
    case "name": return "personas.nameLabel";
    case "tagline": return "characters.form.taglineLabel";
    case "alternate_greetings": return "characters.form.alternateGreetingsLabel";
    case "example_dialogues": return "characters.form.exampleDialoguesLabel";
    case "tags": return "characters.form.tagsLabel";
    case "lore_entries": return "lorebook.title";
    default: return KIND_COPY[kind][field].labelKey;
  }
}

/** The name the form gives any field of a card, by its column. */
export function fieldLabelKey(field: string, kind: Kind): string {
  switch (field) {
    case "kind": return "characters.reread.kind";
    case "system_prompt": return "characters.form.systemPromptLabel";
    case "post_history_instructions": return "characters.form.postHistoryLabel";
    case "creator_notes": return "characters.creatorNotesLabel";
    case "creator": return "characters.form.creatorLabel";
    case "character_version": return "characters.form.versionLabel";
    case "nickname": return "characters.form.nicknameLabel";
    case "character_note": return "characters.form.noteLabel";
    case "creator_notes_multilingual": return "characters.form.multilingualLabel";
    default: return labelKey(field as AssistField, kind);
  }
}
