// The basic text nodes and marks: StarterKit's extensions in its order, minus
// undo/redo (Yjs owns history), its code block (OcCodeBlock in nodes.tsx) and
// the drop / gap cursors (plugins only, registered by late.ts after first
// paint). `link` is our linkify-free mark (link.ts). StarterKit itself would
// bundle @tiptap/extension-link and linkifyjs into the initial JS (docs/02 §7).
// Package subpaths, because the package indexes keep every extension they
// define. schema.test.ts checks the schema still equals StarterKit's.
import { Blockquote } from "@tiptap/extension-blockquote";
import { Bold } from "@tiptap/extension-bold";
import { Code } from "@tiptap/extension-code";
import { Document } from "@tiptap/extension-document";
import { HardBreak } from "@tiptap/extension-hard-break";
import { Heading } from "@tiptap/extension-heading";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import { Italic } from "@tiptap/extension-italic";
import { BulletList } from "@tiptap/extension-list/bullet-list";
import { ListItem } from "@tiptap/extension-list/item";
import { ListKeymap } from "@tiptap/extension-list/keymap";
import { OrderedList } from "@tiptap/extension-list/ordered-list";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Strike } from "@tiptap/extension-strike";
import { Text } from "@tiptap/extension-text";
import { Underline } from "@tiptap/extension-underline";
import { TrailingNode } from "@tiptap/extensions/trailing-node";
import { LinkMark } from "./link";

export const BASE_EXTENSIONS = [
  Bold,
  Blockquote,
  BulletList,
  Code,
  Document,
  HardBreak,
  Heading.configure({ levels: [1, 2, 3] }),
  HorizontalRule,
  Italic,
  ListItem,
  ListKeymap,
  LinkMark,
  OrderedList,
  Paragraph,
  Strike,
  Text,
  Underline,
  TrailingNode,
];
