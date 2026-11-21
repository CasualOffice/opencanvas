// Icons that never show at first paint: menus, toolbars, the slash menu, the
// gutter, templates, the gallery and the icon picker. Loaded on demand by
// icons.tsx (App fetches them right after first paint) so they stay out of the
// initial bundle.
import {
  AlignLeft, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, AtSign, BadgeCheck, Bell, Bold, BookMarked, BookOpen,
  Bookmark, Briefcase, Bug, CalendarDays, CalendarRange, Check, ChevronsDownUp, ClipboardList, Code, CodeXml,
  Coffee, Columns2, Compass, Contact, Database, ExternalLink, FileCode2, FileDown, FileType, FolderKanban, Gauge,
  GripVertical, Handshake, Hash, Heading1, Heading2, Heading3, Heart, HeartHandshake, Highlighter, History, Image,
  Italic, Keyboard, LayoutGrid, Link, List, ListChecks, ListOrdered, ListTodo, Map as MapIcon, Megaphone, Minus,
  MoveHorizontal, Network, NotebookPen, Palette, PanelTop, PartyPopper, Phone, Plane, Play, Plus, Printer, Repeat,
  Rocket, Route, Scale, ScrollText, Search, Shapes, Siren, Smartphone, Smile, Square, SquareCheck, SquareKanban,
  Strikethrough, Table, TextQuote, Trash2, Type, Underline, Undo2, Upload, UserPlus, UserRound, Users, Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";

export const EXTRA: Record<string, LucideIcon> = {
  "align-left": AlignLeft, "arrow-down": ArrowDown, "arrow-left": ArrowLeft, "arrow-right": ArrowRight,
  "arrow-up": ArrowUp, "at-sign": AtSign, "badge-check": BadgeCheck, bell: Bell, bold: Bold,
  "book-marked": BookMarked, "book-open": BookOpen, bookmark: Bookmark, briefcase: Briefcase, bug: Bug,
  "calendar-days": CalendarDays, "calendar-range": CalendarRange, check: Check, "chevrons-down-up": ChevronsDownUp,
  "clipboard-list": ClipboardList, code: Code, "code-xml": CodeXml, coffee: Coffee, "columns-2": Columns2,
  compass: Compass, contact: Contact, database: Database, "external-link": ExternalLink, "file-code-2": FileCode2,
  "file-down": FileDown, "file-type": FileType, "folder-kanban": FolderKanban, gauge: Gauge, "grip-vertical": GripVertical,
  handshake: Handshake, hash: Hash, "heading-1": Heading1, "heading-2": Heading2, "heading-3": Heading3,
  heart: Heart, "heart-handshake": HeartHandshake, highlighter: Highlighter, history: History, image: Image,
  italic: Italic, keyboard: Keyboard, "layout-grid": LayoutGrid, link: Link, list: List,
  "list-checks": ListChecks, "list-ordered": ListOrdered, "list-todo": ListTodo, map: MapIcon,
  megaphone: Megaphone, minus: Minus, "move-horizontal": MoveHorizontal, network: Network,
  "notebook-pen": NotebookPen, palette: Palette, "panel-top": PanelTop, "party-popper": PartyPopper,
  phone: Phone, plane: Plane, play: Play, plus: Plus, printer: Printer, repeat: Repeat, rocket: Rocket,
  route: Route, scale: Scale, "scroll-text": ScrollText, search: Search, shapes: Shapes, siren: Siren,
  smartphone: Smartphone, smile: Smile, square: Square, "square-check": SquareCheck,
  "square-kanban": SquareKanban, strikethrough: Strikethrough, table: Table, "text-quote": TextQuote,
  "trash-2": Trash2, type: Type, underline: Underline, "undo-2": Undo2, upload: Upload, "user-plus": UserPlus,
  "user-round": UserRound, users: Users, workflow: Workflow, zap: Zap,
};
