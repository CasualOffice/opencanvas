// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The `link` mark and the `mention` node, without their heavy runtime parts.
//
// @tiptap/extension-link pulls in linkifyjs (~10 KB gzip) for autolinking and
// @tiptap/extension-mention pulls in @tiptap/suggestion + @floating-ui (~10 KB),
// none of which is needed to show a document (docs/02 §7 budget). The schema
// (names, attrs, defaults, parse/render rules) is identical to those packages
// with our options, so every document parses the same from the first frame;
// `late.ts` registers autolink, link-on-paste and the suggestion plugins on the
// live editor right after first paint. `schema.test.ts` guards the equality.
import { Mark, Node, mergeAttributes } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { readableOn } from "../lib/color";
import { peopleChanged, peopleRef } from "../lib/people";

export const LINK_OPTIONS = {
  openOnClick: false,
  autolink: true,
  linkOnPaste: true,
  defaultProtocol: "http",
  protocols: [] as string[],
  HTMLAttributes: { target: "_blank", rel: "noopener noreferrer nofollow" },
};

const WS = /[\0- \xA0\u1680\u180E\u2000-\u2029\u205F\u3000]/g;
const ALLOWED = ["http", "https", "ftp", "ftps", "mailto", "tel", "callto", "sms", "cid", "xmpp"];
const ALLOWED_RE = new RegExp(`^(?:(?:${ALLOWED.join("|")}):|[^a-z]|[a-z0-9+.\\-]+(?:[^a-z+.\\-:]|$))`, "i");

/** Same check as @tiptap/extension-link's `isAllowedUri` with no custom protocols. */
export function isAllowedUri(uri: string | null | undefined): boolean {
  return !uri || ALLOWED_RE.test(uri.replace(WS, ""));
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    ocLink: {
      setLink: (attributes: { href: string; target?: string | null; rel?: string | null; class?: string | null; title?: string | null }) => ReturnType;
      toggleLink: (attributes?: { href: string; target?: string | null; rel?: string | null; class?: string | null; title?: string | null }) => ReturnType;
      unsetLink: () => ReturnType;
    };
  }
}

export const LinkMark = Mark.create({
  name: "link",
  priority: 1000,
  keepOnSplit: false,
  exitable: true,
  inclusive: () => LINK_OPTIONS.autolink,
  addAttributes() {
    const h = LINK_OPTIONS.HTMLAttributes;
    return {
      href: { default: null, parseHTML: (el) => el.getAttribute("href") },
      target: { default: h.target ?? null },
      rel: { default: h.rel ?? null },
      class: { default: null },
      title: { default: null },
    };
  },
  parseHTML: () => [{ tag: "a[href]", getAttrs: (dom) => (isAllowedUri((dom as HTMLElement).getAttribute("href")) ? null : false) }],
  renderHTML({ HTMLAttributes }) {
    const href = isAllowedUri(HTMLAttributes.href) ? HTMLAttributes.href : "";
    return ["a", mergeAttributes(LINK_OPTIONS.HTMLAttributes, { ...HTMLAttributes, href }), 0];
  },
  addCommands() {
    return {
      setLink:
        (attributes) =>
        ({ chain }) =>
          isAllowedUri(attributes.href) && chain().setMark(this.name, attributes).setMeta("preventAutolink", true).run(),
      toggleLink:
        (attributes) =>
        ({ chain }) =>
          !(attributes?.href && !isAllowedUri(attributes.href)) &&
          chain().toggleMark(this.name, attributes, { extendEmptyMarkRange: true }).setMeta("preventAutolink", true).run(),
      unsetLink:
        () =>
        ({ chain }) =>
          chain().unsetMark(this.name, { extendEmptyMarkRange: true }).setMeta("preventAutolink", true).run(),
    };
  },
});

function initialsOf(name: string) {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}

/**
 * Same schema as @tiptap/extension-mention (name, priority, attrs, parse rule);
 * rendered as an avatar chip. `colorFor` maps a user id to their colour.
 */
export function mentionNode(colorFor: (id: string) => string) {
  return Node.create({
    name: "mention",
    priority: 101,
    group: "inline",
    inline: true,
    selectable: false,
    atom: true,
    addAttributes() {
      return {
        id: {
          default: null,
          parseHTML: (el) => el.getAttribute("data-id"),
          renderHTML: (a) => (a.id ? { "data-id": a.id } : {}),
        },
        label: {
          default: null,
          parseHTML: (el) => el.getAttribute("data-label"),
          renderHTML: (a) => (a.label ? { "data-label": a.label } : {}),
        },
        mentionSuggestionChar: {
          default: "@",
          parseHTML: (el) => el.getAttribute("data-mention-suggestion-char"),
          renderHTML: (a) => ({ "data-mention-suggestion-char": a.mentionSuggestionChar }),
        },
      };
    },
    parseHTML: () => [{ tag: 'span[data-type="mention"]' }],
    // docs/21: the chip shows how *this viewer* sees the id (their resolve answer, else tokens,
    // else the stored label). The stored label is never put in the DOM: it is what the author
    // saw, and may be a name this viewer mustn't see.
    addNodeView() {
      return ({ node, editor }) => {
        let n = node;
        const dom = document.createElement("span");
        dom.className = "mention";
        dom.dataset.type = "mention";
        const av = document.createElement("span");
        av.className = "av";
        av.setAttribute("aria-hidden", "true");
        const text = document.createElement("span");
        text.className = "mn";
        const note = document.createElement("span");
        note.className = "mn-note";
        note.hidden = true;
        dom.append(av, text, note);
        const render = () => {
          const id = String(n.attrs.id ?? "");
          const people = peopleRef.current;
          const v = people ? people.get(id, n.attrs.label) : { id, name: String(n.attrs.label ?? id), color: colorFor(id), avatar: undefined, deactivated: false };
          const name = v.name;
          dom.dataset.id = id;
          dom.dataset.personId = id;
          dom.classList.toggle("former", !!v.deactivated);
          // Focusable when read-only; while editing, the caret next to it opens the card.
          if (editor.isEditable) dom.removeAttribute("tabindex");
          else dom.tabIndex = 0;
          text.textContent = name;
          note.textContent = v.deactivated ? "No longer has access" : "";
          note.hidden = !v.deactivated;
          if (v.deactivated) text.setAttribute("aria-label", `${name}, no longer has access`);
          else text.removeAttribute("aria-label");
          av.style.background = v.color;
          av.style.color = readableOn(v.color);
          av.replaceChildren();
          if (v.avatar) {
            const img = document.createElement("img");
            img.src = v.avatar;
            img.alt = "";
            av.append(img);
          } else av.textContent = people ? people.initialsOf(id, name) : initialsOf(name);
        };
        render();
        let sub = peopleRef.current?.subscribe(render);
        const offRef = peopleChanged.subscribe(() => {
          sub?.();
          sub = peopleRef.current?.subscribe(render);
          render();
        });
        return {
          dom,
          update(next) {
            if (next.type !== n.type) return false;
            n = next;
            render();
            return true;
          },
          ignoreMutation: () => true,
          destroy() {
            sub?.();
            offRef();
          },
        };
      };
    },
    renderHTML: ({ node }) => {
      const id = String(node.attrs.id ?? "");
      const seen = peopleRef.current?.get(id, node.attrs.label);
      const label = seen ? seen.name : String(node.attrs.label ?? id);
      return [
        "span",
        { class: "mention", "data-type": "mention", "data-id": id, "data-label": label },
        ["span", { class: "av", style: `background:${colorFor(id)};color:${readableOn(colorFor(id))}`, "aria-hidden": "true" }, initialsOf(label)],
        label,
      ];
    },
    renderText: ({ node }) => "@" + (node.attrs.label ?? node.attrs.id),
    addKeyboardShortcuts() {
      // As @tiptap/extension-mention: Backspace after a mention turns it back into its trigger char.
      return {
        Backspace: () =>
          this.editor.commands.command(({ tr, state }) => {
            const { empty, anchor } = state.selection;
            if (!empty) return false;
            let found: PMNode | null = null;
            let at = 0;
            state.doc.nodesBetween(anchor - 1, anchor, (n, pos) => {
              if (n.type.name === this.name) {
                found = n;
                at = pos;
                return false;
              }
            });
            if (!found) return false;
            const m = found as PMNode;
            tr.insertText(String(m.attrs.mentionSuggestionChar), at, at + m.nodeSize);
            return true;
          }),
      };
    },
  });
}
