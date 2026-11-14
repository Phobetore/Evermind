// What the presentation's chain and the conversation's share. Types are its only imports: the
// conversation reads it from the main bundle, without the layout code.
import type { ElementContent, Root, RootContent } from "hast";
import type { Nodes as MdastNodes, Root as MdastRoot } from "mdast";
import type { Processor } from "unified";
import { DEPTH_BOUND } from "./bounds";

/** A remark plugin: reference definitions are not read. It adds
 *  { disable: { null: ["definition"] } } to the processor's micromarkExtensions; `[r]: address`
 *  stays the text it is, and `[a][r]` too. One definition used a thousand times would otherwise
 *  write its whole address a thousand times into the tree. */
export function noDefinitions(this: Processor): void {
  const data = this.data() as { micromarkExtensions?: unknown[] };
  if (!data.micromarkExtensions) data.micromarkExtensions = [];
  data.micromarkExtensions.push({ disable: { null: ["definition"] } });
}

/** What micromark does not read in the model's own text: written HTML, links, images, automatic
 *  links, reference definitions and character references. The model reads them as written, and
 *  so they are shown: no element of the card's, nothing fetched, nothing to follow, no text hidden
 *  from the person. A reference decoded would draw what the model never reads: `&#8203;` an
 *  invisible space, `&#x202E;` a line turned backwards on screen, `&lt;b&gt;` a tag that is not
 *  in the text. A backslash escape stays read: like `**`, it is markup the layout takes away, it
 *  draws no character the text does not hold, and « As written » shows it. */
const NOT_IN_MODEL_TEXT = [
  "htmlFlow",
  "htmlText",
  "labelStartLink",
  "labelStartImage",
  "labelEnd",
  "autolink",
  "definition",
  "characterReference",
];

/** A remark plugin, used after the presentation's dialect (which keeps tables, strikethrough and
 *  single line breaks): the model's text is laid out in that dialect without the constructs of
 *  NOT_IN_MODEL_TEXT. The presentation's dialect stays in the layout's own file, with the
 *  extensions it imports: this one keeps types as its only imports. */
export function modelDialect(this: Processor): (tree: MdastRoot) => void {
  const data = this.data() as { micromarkExtensions?: unknown[] };
  if (!data.micromarkExtensions) data.micromarkExtensions = [];
  data.micromarkExtensions.push({ disable: { null: NOT_IN_MODEL_TEXT } });
  return fenceInfoShown;
}

/** The words after a code fence's opening marks (```js these words) are put back as the first
 *  line of its code. The layout would keep only the first word, in a class nobody sees, and drop
 *  the rest: text the model reads that the person would not. A walk by a stack: the tree is not
 *  bounded in depth yet. */
function fenceInfoShown(tree: MdastRoot): void {
  const stack: MdastNodes[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "code") {
      const info = [node.lang, node.meta].filter((part) => part).join(" ");
      if (info !== "") node.value = node.value === "" ? info : info + "\n" + node.value;
      node.lang = null;
      node.meta = null;
    } else if ("children" in node) for (const child of node.children) stack.push(child);
  }
}

/** A rehype plugin, and what cardRules calls on its tree: an element more than DEPTH_BOUND
 *  elements from the root is replaced by its children. It never calls itself deeper than
 *  DEPTH_BOUND: what lies below is flattened in a loop. Rendering and the browser's layout are
 *  recursive, and a hostile card nested ten thousand deep would bring the tab down. */
export function boundDepth(): (tree: Root) => void {
  return (tree) => {
    const stack: Array<[{ children: Array<RootContent | ElementContent> }, number]> = [[tree, 0]];
    while (stack.length > 0) {
      const [parent, depth] = stack.pop()!;
      if (depth === DEPTH_BOUND) {
        // Every element below is unwrapped, its content kept in order.
        const flat: ElementContent[] = [];
        const pending: Array<RootContent | ElementContent> = [...parent.children].reverse();
        while (pending.length > 0) {
          const node = pending.pop()!;
          if (node.type === "element") {
            for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
          } else if (node.type !== "doctype") flat.push(node);
        }
        parent.children = flat;
        continue;
      }
      for (const child of parent.children) if (child.type === "element") stack.push([child, depth + 1]);
    }
  };
}
