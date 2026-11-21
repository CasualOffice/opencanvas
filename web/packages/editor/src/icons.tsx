// Lucide icons only (never emoji). Every icon goes through <Ic> so stroke width
// and sizing stay consistent with the approved prototype (strokeWidth 1.75).
//
// Only icons a document can show at first paint are bundled here: the top bar,
// the header, status and error screens, and the blocks' own views (callout
// icons, toggles, files, embeds, images). Menu, toolbar, slash-menu, template,
// gallery and picker icons live in icons-extra.ts, which App fetches right after
// first paint (docs/02 §7 bundle budget); until it arrives <Ic> keeps an empty
// box of the same size, so nothing shifts.
import {
  Calendar, ChevronDown, ChevronRight, File as FileIcon, FileArchive, FileAudio, FileCode, FileImage, FileVideo, CircleCheck, CirclePause, CirclePlay, Clock, CloudOff, Copy, Download, Ellipsis, Eye,
  FileSpreadsheet, FileText, Flag, Globe, ImagePlus, Info, LayoutTemplate, Lightbulb, Link2, LoaderCircle, Lock,
  MapPin, Maximize2, MessageSquare, MessageSquarePlus, Paperclip, PenTool, RotateCcw, ShieldCheck, Sparkles, Star,
  Target, TriangleAlert, UsersRound, WifiOff, X,
  type LucideIcon,
} from "lucide-react";
import { createStore, useStore } from "./lib/store";

export const ICONS: Record<string, LucideIcon> = {
  calendar: Calendar, file: FileIcon, "file-archive": FileArchive, "file-audio": FileAudio, "file-code": FileCode,
  "file-image": FileImage, "file-video": FileVideo, "chevron-down": ChevronDown, "chevron-right": ChevronRight, "circle-check": CircleCheck, "circle-pause": CirclePause,
  "circle-play": CirclePlay, clock: Clock, "cloud-off": CloudOff, copy: Copy, download: Download,
  ellipsis: Ellipsis, eye: Eye, "file-spreadsheet": FileSpreadsheet, "file-text": FileText, flag: Flag,
  globe: Globe, "image-plus": ImagePlus, info: Info, "layout-template": LayoutTemplate, lightbulb: Lightbulb,
  "link-2": Link2, "loader-circle": LoaderCircle, lock: Lock, "map-pin": MapPin, "maximize-2": Maximize2,
  "message-square": MessageSquare, "message-square-plus": MessageSquarePlus, paperclip: Paperclip,
  "pen-tool": PenTool, "rotate-ccw": RotateCcw, "shield-check": ShieldCheck, sparkles: Sparkles, star: Star,
  target: Target, "triangle-alert": TriangleAlert, "users-round": UsersRound, "wifi-off": WifiOff, x: X,
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
