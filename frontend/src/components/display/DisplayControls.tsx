import { RpText } from "@/components/chat/RpText";
import type { ConversationBackdrop } from "@/components/chat/useConversationBackdrop";
import { useT } from "@/i18n/useT";
import { backdropOf, setDisplay, TEXT_SCALE, useDisplay } from "@/lib/display";
import type { Conversation } from "@/types";
import { clsx } from "clsx";
import { useEffect, useId, useRef } from "react";

const percent = (value: number) => Math.round(value * 100);
const TEXT_STEP = percent(TEXT_SCALE.step);

/** The size of a conversation's text and the picture behind it, as this device shows them: in
 *  Settings, and in the sheet over a conversation, where the strength is the one drawn there. */
export function DisplayControls(props:
  | { where: "settings" }
  // The character is conversation.character: the sheet calls backdropOf(conversation, conversation.character, useDisplay()).
  | { where: "conversation"; conversation: Conversation; backdrop: ConversationBackdrop;
      /** The strength slider takes the focus as the sheet opens (`onOpenDisplay("strength")`). */
      focusStrength?: boolean }
) {
  const t = useT();
  const display = useDisplay();
  const ids = useId();
  const strengthSlider = useRef<HTMLInputElement>(null);
  const focusStrength = props.where === "conversation" && props.focusStrength;
  // After the sheet has opened: a control in a dialog that is not shown yet cannot take the focus.
  useEffect(() => {
    if (focusStrength) strengthSlider.current?.focus();
  }, [focusStrength]);

  const text = percent(display.text);
  const textValue = text === 100 ? t("display.scaleOriginal", { pct: text }) : t("display.scale", { pct: text });
  const nudge = (by: number) => setDisplay({ text: display.text + by * TEXT_SCALE.step });

  let strength: number;
  let strengthValue: string;
  let shownNothing: boolean;
  let ownLink: React.ReactNode = null;
  if (props.where === "settings") {
    strength = display.strength;
    shownNothing = !display.portrait;
    strengthValue = shownNothing ? t("display.hidden") : t("display.scale", { pct: percent(strength) });
  } else {
    const { conversation, backdrop } = props;
    const shown = backdropOf(conversation, conversation.character, display);
    strength = shown.strength;
    shownNothing = shown.src === null;
    // Why nothing is drawn, most deliberate first.
    strengthValue = shownNothing
      ? conversation.backdrop !== "auto"
        ? t("display.noneHere")
        : !display.portrait
          ? t("display.hidden")
          : t("display.noPicture")
      : shown.own
        ? t("display.strengthConversation", { pct: percent(strength) })
        : t("display.strengthDevice", { pct: percent(strength) });
    // One button whose words change, so the focus stays on it once pressed.
    if (!shownNothing) {
      ownLink = (
        <button
          type="button"
          className="touch-target mt-1 text-left text-xs text-ember-300 underline decoration-ember-600/50 underline-offset-2 transition-colors hover:text-parchment"
          onClick={() => backdrop.setStrength(shown.own ? null : display.strength)}
        >
          {shown.own
            ? t("display.deviceStrength", { pct: percent(display.strength) })
            : t("display.ownStrength")}
        </button>
      );
    }
  }

  function setStrength(value: number) {
    if (props.where === "conversation") {
      const own = backdropOf(props.conversation, props.conversation.character, display).own;
      if (own) {
        props.backdrop.setStrength(value);
        return;
      }
    }
    setDisplay({ strength: value });
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3">
          <label htmlFor={`${ids}-text`} className="text-sm text-parchment-dim">{t("display.textSize")}</label>
          <span className="shrink-0 text-sm tabular-nums text-mist">{textValue}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-ink-600 font-display text-sm text-parchment-dim transition-colors hover:bg-ink-800 hover:text-parchment"
            aria-label={t("display.smaller")}
            title={t("display.smaller")}
            onClick={() => nudge(-1)}
          >
            A
          </button>
          <input
            id={`${ids}-text`}
            type="range"
            min={percent(TEXT_SCALE.min)}
            max={percent(TEXT_SCALE.max)}
            step={TEXT_STEP}
            value={text}
            aria-valuetext={textValue}
            onChange={(e) => setDisplay({ text: Number(e.target.value) / 100 })}
            className="min-w-0 flex-1 accent-[#e29a3e]"
          />
          <button
            type="button"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-ink-600 font-display text-xl text-parchment-dim transition-colors hover:bg-ink-800 hover:text-parchment"
            aria-label={t("display.larger")}
            title={t("display.larger")}
            onClick={() => nudge(1)}
          >
            A
          </button>
        </div>
      </div>

      {props.where === "settings" && (
        // Under the same scale as a conversation, and only there.
        <div
          className="rounded-xl border border-ink-700 bg-ink-900/60 px-4 py-3"
          style={{ "--chat-scale": display.text } as React.CSSProperties}
        >
          <RpText text={t("display.sample")} />
        </div>
      )}

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <span id={`${ids}-portrait`} className="block text-sm text-parchment-dim">{t("display.portrait")}</span>
          <span id={`${ids}-portrait-hint`} className="mt-0.5 block text-xs text-mist">{t("display.portraitHint")}</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={display.portrait}
          aria-labelledby={`${ids}-portrait`}
          aria-describedby={`${ids}-portrait-hint`}
          onClick={() => setDisplay({ portrait: !display.portrait })}
          className="touch-target relative mt-0.5 h-6 w-11 shrink-0 rounded-full"
        >
          <span
            aria-hidden
            className={clsx(
              "absolute inset-0 rounded-full border transition-colors",
              display.portrait ? "border-ember-500 bg-ember-600" : "border-ink-600 bg-ink-800",
            )}
          />
          <span
            aria-hidden
            className={clsx(
              "absolute top-1 left-1 h-4 w-4 rounded-full bg-parchment transition-transform",
              display.portrait && "translate-x-5",
            )}
          />
        </button>
      </div>

      <div>
        <div className="mb-1 flex items-baseline justify-between gap-3">
          <label htmlFor={`${ids}-strength`} className="text-sm text-parchment-dim">{t("display.strength")}</label>
          <span className="shrink-0 text-sm tabular-nums text-mist">{strengthValue}</span>
        </div>
        <input
          ref={strengthSlider}
          id={`${ids}-strength`}
          type="range"
          min={0}
          max={100}
          value={percent(strength)}
          disabled={shownNothing}
          aria-valuetext={strengthValue}
          onChange={(e) => setStrength(Number(e.target.value) / 100)}
          className="w-full accent-[#e29a3e] disabled:opacity-40"
        />
        <div aria-hidden className="flex justify-between text-xs text-mist-dim">
          <span>{t("display.faint")}</span>
          <span>{t("display.strong")}</span>
        </div>
        {ownLink}
      </div>

      {props.where === "settings" ? (
        <div className="flex flex-col gap-1 text-xs leading-relaxed text-mist">
          <p>{t("display.softened")}</p>
          <p>{t("display.perDevice")}</p>
        </div>
      ) : (
        <p className="text-xs leading-relaxed text-mist">{t("display.sheetFoot")}</p>
      )}
    </div>
  );
}
