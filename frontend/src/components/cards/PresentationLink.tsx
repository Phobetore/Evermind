import { HOST_MARK, withHosts } from "@/components/cards/hosts";
import { InLink } from "@/components/cards/PresentationImage";
import { useConfirm } from "@/components/ui/Confirm";
import { useT } from "@/i18n/useT";

/** A link of a presentation, its address already checked by cardRules. One whose text says where
 *  it leads is a link like any other; one whose text shows another site, could be read as one, or
 *  holds a picture asks first, naming the real site, and has no address in the page for a long
 *  press, a middle click or "copy link" to take without that question. */
export function PresentationLink({
  href,
  title,
  style,
  children,
  "data-real": real,
  "data-shown": shown,
  "data-picture": picture,
}: {
  href?: string;
  title?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
  // Set by cardRules, which read the link's text and the alt of its images in the tree.
  "data-real"?: string;
  "data-shown"?: string;
  "data-picture"?: string;
}) {
  const t = useT();
  const confirm = useConfirm();

  if (!href) return <span>{children}</span>;
  const mail = href.startsWith("mailto:");

  if (real === undefined) {
    return (
      <InLink.Provider value={true}>
        <a
          href={href}
          title={title}
          style={style}
          target={mail ? undefined : "_blank"}
          rel="noopener noreferrer nofollow"
          referrerPolicy="no-referrer"
        >
          {children}
        </a>
      </InLink.Provider>
    );
  }

  const ask = async () => {
    // The question names no host: it is the box's title, a string, where a host chosen by the
    // card would read as Evermind's words. The hosts go under it, each shown as a site's name.
    const question =
      shown !== undefined
        ? t("characters.presentation.linkElsewhere")
        : picture !== undefined
          ? t("characters.presentation.linkPicture")
          : t("characters.presentation.linkUnclear");
    const yes = await confirm(question, {
      action: t("characters.presentation.openLink"),
      details: (
        <>
          <p>{withHosts(t("characters.presentation.linkLeadsTo", { host: HOST_MARK }), [real])}</p>
          {shown !== undefined && <p>{withHosts(t("characters.presentation.linkShows", { host: HOST_MARK }), [shown])}</p>}
        </>
      ),
    });
    if (!yes) return;
    if (mail) window.location.href = href;
    else window.open(href, "_blank", "noopener,noreferrer");
  };

  return (
    <InLink.Provider value={true}>
      <a
        role="link"
        tabIndex={0}
        title={title}
        style={style}
        aria-haspopup="dialog"
        className="cursor-pointer"
        onClick={(event) => {
          event.preventDefault();
          void ask();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          void ask();
        }}
      >
        {children}
      </a>
    </InLink.Provider>
  );
}
