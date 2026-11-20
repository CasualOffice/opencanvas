// Lucide icons only (never emoji). Every icon goes through <Ic> so stroke width
// and sizing stay consistent with the approved prototype (strokeWidth 1.75).
import {
  AlignLeft, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, AtSign, BadgeCheck, Bell, Bold, BookMarked, BookOpen,
  Bookmark, Briefcase, Bug, Calendar, CalendarDays, CalendarRange, Check, ChevronDown, ChevronRight,
  ChevronsDownUp, CircleCheck, CirclePlay, ClipboardList, Clock, CloudOff, CodeXml, Coffee, Columns2, Compass,
  Contact, Copy, Database, Download, Ellipsis, ExternalLink, Eye, FileCode2, FileDown, FileSpreadsheet, FileText,
  Flag, FolderKanban, Gauge, Globe, GripVertical, Handshake, Hash, Heading1, Heading2, Heading3, Heart,
  HeartHandshake, Highlighter, History, Image, ImagePlus, Info, Italic, Keyboard, LayoutGrid, LayoutTemplate,
  Lightbulb, Link, Link2, List, ListChecks, ListOrdered, ListTodo, LoaderCircle, Lock, Map as MapIcon, MapPin,
  Maximize2, Megaphone, MessageSquare, MessageSquarePlus, Minus, MoveHorizontal, Network, NotebookPen,
  PanelTop, Palette, Paperclip, PartyPopper, PenTool, Phone, Plane, Play, Plus, Repeat, Rocket, RotateCcw, Route,
  Scale, ScrollText, Search, Shapes, ShieldCheck, Siren, Smile, Sparkles, SquareKanban, Star, Strikethrough,
  Table, Target, TextQuote, Trash2, TriangleAlert, Type, Underline, Undo2, Upload, UserPlus, UserRound,
  UsersRound, WifiOff, Workflow, X, Zap, Code, Users, Smartphone, Square, SquareCheck,
  type LucideIcon,
} from "lucide-react";

export const ICONS: Record<string, LucideIcon> = {
  "align-left": AlignLeft, "arrow-down": ArrowDown, "arrow-left": ArrowLeft, "arrow-right": ArrowRight,
  "arrow-up": ArrowUp, "at-sign": AtSign, "badge-check": BadgeCheck, bell: Bell, bold: Bold,
  "book-marked": BookMarked, "book-open": BookOpen, bookmark: Bookmark, briefcase: Briefcase, bug: Bug,
  calendar: Calendar, "calendar-days": CalendarDays, "calendar-range": CalendarRange, check: Check,
  "chevron-down": ChevronDown, "chevron-right": ChevronRight, "chevrons-down-up": ChevronsDownUp,
  "circle-check": CircleCheck, "circle-play": CirclePlay, "clipboard-list": ClipboardList, clock: Clock,
  "cloud-off": CloudOff, "code-xml": CodeXml, code: Code, coffee: Coffee, "columns-2": Columns2, compass: Compass,
  contact: Contact, copy: Copy, database: Database, download: Download, ellipsis: Ellipsis,
  "external-link": ExternalLink, eye: Eye, "file-code-2": FileCode2, "file-down": FileDown,
  "file-spreadsheet": FileSpreadsheet, "file-text": FileText, flag: Flag, "folder-kanban": FolderKanban,
  gauge: Gauge, globe: Globe, "grip-vertical": GripVertical, handshake: Handshake, hash: Hash,
  "heading-1": Heading1, "heading-2": Heading2, "heading-3": Heading3, heart: Heart,
  "heart-handshake": HeartHandshake, highlighter: Highlighter, history: History, image: Image,
  "image-plus": ImagePlus, info: Info, italic: Italic, keyboard: Keyboard, "layout-grid": LayoutGrid,
  "layout-template": LayoutTemplate, lightbulb: Lightbulb, link: Link, "link-2": Link2, list: List,
  "list-checks": ListChecks, "list-ordered": ListOrdered, "list-todo": ListTodo, "loader-circle": LoaderCircle,
  lock: Lock, map: MapIcon, "map-pin": MapPin, "maximize-2": Maximize2, megaphone: Megaphone,
  "message-square": MessageSquare, "message-square-plus": MessageSquarePlus, minus: Minus,
  "move-horizontal": MoveHorizontal, network: Network, "notebook-pen": NotebookPen, "panel-top": PanelTop,
  palette: Palette, paperclip: Paperclip, "party-popper": PartyPopper, "pen-tool": PenTool, phone: Phone,
  plane: Plane, play: Play, plus: Plus, repeat: Repeat, rocket: Rocket, "rotate-ccw": RotateCcw, route: Route,
  scale: Scale, "scroll-text": ScrollText, search: Search, shapes: Shapes, "shield-check": ShieldCheck,
  siren: Siren, smile: Smile, sparkles: Sparkles, "square-kanban": SquareKanban, star: Star,
  strikethrough: Strikethrough, table: Table, target: Target, "text-quote": TextQuote, "trash-2": Trash2,
  "triangle-alert": TriangleAlert, type: Type, underline: Underline, "undo-2": Undo2, upload: Upload,
  "user-plus": UserPlus, "user-round": UserRound, "users-round": UsersRound, users: Users, "wifi-off": WifiOff,
  workflow: Workflow, x: X, zap: Zap, smartphone: Smartphone, square: Square, "square-check": SquareCheck,
};

/** Icons a person can pick for the canvas header and callouts. */
export const PICKABLE = [
  "file-text", "rocket", "target", "lightbulb", "notebook-pen", "calendar", "users-round", "map", "flag",
  "star", "heart", "zap", "bookmark", "bell", "compass", "palette", "code-xml", "bug", "briefcase",
  "handshake", "list-todo", "book-open", "sparkles", "info", "triangle-alert", "clock", "shapes", "database",
];

export function Ic({ name, size = 16, className, style }: { name: string; size?: number; className?: string; style?: React.CSSProperties }) {
  const C = ICONS[name] ?? FileText;
  return <C size={size} strokeWidth={1.75} className={"lucide " + (className ?? "")} style={style} aria-hidden="true" />;
}
