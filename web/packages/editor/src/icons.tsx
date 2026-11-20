// Lucide icons only (never emoji). Every icon goes through <Ic> so stroke width
// and sizing stay consistent with the approved prototype (strokeWidth 1.75).
//
// The editor chrome's icons are bundled here. Icons that only templates, the
// gallery and the icon picker use live in icons-extra.ts and load on demand
// (docs/02 §7 bundle budget); until they arrive <Ic> keeps an empty box of
// the same size, so nothing shifts.
import {
  ArrowDown, ArrowUp, AtSign, Bold, Bookmark, Calendar, Check, ChevronDown, ChevronRight, ChevronsDownUp,
  CircleCheck, CirclePlay, Clock, CloudOff, Code, CodeXml, Columns2, Copy, Database, Download, Ellipsis,
  ExternalLink, Eye, FileDown, FileSpreadsheet, FileText, Flag, Globe, GripVertical, Heading1, Heading2, Heading3,
  Highlighter, History, Image, ImagePlus, Info, Italic, Keyboard, LayoutTemplate, Lightbulb, Link, Link2, List,
  ListOrdered, ListTodo, LoaderCircle, Lock, MapPin, Maximize2, MessageSquare, MessageSquarePlus, Minus,
  MoveHorizontal, Network, PanelTop, Paperclip, PenTool, Play, Plus, Printer, Rocket, RotateCcw, Shapes,
  ShieldCheck, Sparkles, Star, Strikethrough, Table, Target, TextQuote, Trash2, TriangleAlert, Type, Underline,
  Upload, UsersRound, WifiOff, X,
  type LucideIcon,
} from "lucide-react";
import { createStore, useStore } from "./lib/store";

export const ICONS: Record<string, LucideIcon> = {
  "arrow-down": ArrowDown, "arrow-up": ArrowUp, "at-sign": AtSign, bold: Bold, bookmark: Bookmark,
  calendar: Calendar, check: Check, "chevron-down": ChevronDown, "chevron-right": ChevronRight,
  "chevrons-down-up": ChevronsDownUp, "circle-check": CircleCheck, "circle-play": CirclePlay, clock: Clock,
  "cloud-off": CloudOff, code: Code, "code-xml": CodeXml, "columns-2": Columns2, copy: Copy, database: Database,
  download: Download, ellipsis: Ellipsis, "external-link": ExternalLink, eye: Eye, "file-down": FileDown,
  "file-spreadsheet": FileSpreadsheet, "file-text": FileText, flag: Flag, globe: Globe,
  "grip-vertical": GripVertical, "heading-1": Heading1, "heading-2": Heading2, "heading-3": Heading3,
  highlighter: Highlighter, history: History, image: Image, "image-plus": ImagePlus, info: Info, italic: Italic,
  keyboard: Keyboard, "layout-template": LayoutTemplate, lightbulb: Lightbulb, link: Link, "link-2": Link2,
  list: List, "list-ordered": ListOrdered, "list-todo": ListTodo, "loader-circle": LoaderCircle, lock: Lock,
  "map-pin": MapPin, "maximize-2": Maximize2, "message-square": MessageSquare,
  "message-square-plus": MessageSquarePlus, minus: Minus, "move-horizontal": MoveHorizontal, network: Network,
  "panel-top": PanelTop, paperclip: Paperclip, "pen-tool": PenTool, play: Play, plus: Plus, printer: Printer,
  rocket: Rocket, "rotate-ccw": RotateCcw, shapes: Shapes, "shield-check": ShieldCheck, sparkles: Sparkles,
  star: Star, strikethrough: Strikethrough, table: Table, target: Target, "text-quote": TextQuote,
  "trash-2": Trash2, "triangle-alert": TriangleAlert, type: Type, underline: Underline, upload: Upload,
  "users-round": UsersRound, "wifi-off": WifiOff, x: X,
};

/** Icons a person can pick for the canvas header and callouts. */
export const PICKABLE = [
  "file-text", "rocket", "target", "lightbulb", "notebook-pen", "calendar", "users-round", "map", "flag",
  "star", "heart", "zap", "bookmark", "bell", "compass", "palette", "code-xml", "bug", "briefcase",
  "handshake", "list-todo", "book-open", "sparkles", "info", "triangle-alert", "clock", "shapes", "database",
];

const extra = createStore<Record<string, LucideIcon> | null>(null);
let loading: Promise<void> | null = null;

/** Loads the template / picker icons. Safe to call often. */
export function loadExtraIcons(): Promise<void> {
  return (loading ??= import("./icons-extra").then(
    (m) => extra.set(m.EXTRA),
    () => {
      loading = null;
    },
  ));
}

export function Ic({ name, size = 16, className, style }: { name: string; size?: number; className?: string; style?: React.CSSProperties }) {
  const more = useStore(extra);
  let C = ICONS[name] ?? more?.[name];
  if (!C) {
    if (!more) {
      void loadExtraIcons();
      return <span className={"lucide " + (className ?? "")} style={{ width: size, height: size, display: "block", flex: "none", ...style }} aria-hidden="true" />;
    }
    C = FileText;
  }
  return <C size={size} strokeWidth={1.75} className={"lucide " + (className ?? "")} style={style} aria-hidden="true" />;
}
