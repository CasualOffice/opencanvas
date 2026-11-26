// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Icons that never show at first paint: menus, toolbars, the slash menu, the
// gutter, templates, the gallery and the icon picker. Loaded on demand by
// icons.tsx (App fetches them right after first paint) so they stay out of the
// initial bundle.
import {
  AlignCenter, AlignLeft, AlignRight, ArrowDown, BetweenHorizontalEnd, BetweenHorizontalStart, BetweenVerticalEnd,
  BetweenVerticalStart, Columns3, Command, Pencil, Rows2, Unlink, ArrowLeft, ArrowRight, ArrowUp, AtSign, BadgeCheck, Bell, Bold, BookMarked, BookOpen,
  Bookmark, Briefcase, Bug, CalendarDays, CalendarRange, Check, ChevronsDownUp, ClipboardList, Code, CodeXml,
  Coffee, Columns2, Compass, Contact, Database, ExternalLink, FileCode2, FileDown, FileType, FolderKanban, Gauge,
  GripVertical, Handshake, Hash, Tag, Heading1, Heading2, Heading3, Heart, HeartHandshake, Highlighter, History, Image,
  Italic, Keyboard, LayoutGrid, Link, List, ListChecks, ListOrdered, ListTodo, Map as MapIcon, Megaphone, Minus,
  MoveHorizontal, Network, NotebookPen, Palette, PanelTop, PartyPopper, Phone, Plane, Play, Plus, Printer, Repeat,
  Rocket, Route, Scale, ScrollText, Search, Shapes, Siren, Smartphone, Smile, Square, SquareCheck, SquareKanban,
  Strikethrough, Table, TextQuote, Trash2, Type, Underline, Undo2, Upload, UserPlus, UserRound, Users, Workflow,
  Zap, Baseline, CalendarPlus, Minimize2, ZoomIn, ZoomOut, ChevronLeft, MoveVertical, RefreshCw, RectangleHorizontal,
  Pilcrow, FileSearch, Kanban, Heading, Columns4, PanelLeft, Boxes, Split, AppWindow, CornerDownRight, FileStack, FileX, ImageOff, Puzzle, SquareDashed, Building2,
  type LucideIcon,
} from "lucide-react";

export const EXTRA: Record<string, LucideIcon> = {
  // Insert menu (INS-01).
  "file-search": FileSearch,
  pilcrow: Pilcrow, kanban: Kanban, heading: Heading, "columns-4": Columns4, "panel-left": PanelLeft, boxes: Boxes, split: Split, "app-window": AppWindow,
  // Diagram import report (DGM-15, approved frames 7b-7e).
  "corner-down-right": CornerDownRight, "file-stack": FileStack, "file-x": FileX, "image-off": ImageOff, puzzle: Puzzle, "square-dashed": SquareDashed, "building-2": Building2,
  "align-center": AlignCenter, "align-left": AlignLeft, "align-right": AlignRight,
  "between-horizontal-end": BetweenHorizontalEnd, "between-horizontal-start": BetweenHorizontalStart,
  "between-vertical-end": BetweenVerticalEnd, "between-vertical-start": BetweenVerticalStart, "columns-3": Columns3,
  command: Command, pencil: Pencil, "rows-2": Rows2, unlink: Unlink, "arrow-down": ArrowDown, "arrow-left": ArrowLeft, "arrow-right": ArrowRight,
  "arrow-up": ArrowUp, "at-sign": AtSign, "badge-check": BadgeCheck, bell: Bell, bold: Bold,
  "book-marked": BookMarked, "book-open": BookOpen, bookmark: Bookmark, briefcase: Briefcase, bug: Bug,
  "calendar-days": CalendarDays, "calendar-range": CalendarRange, check: Check, "chevrons-down-up": ChevronsDownUp,
  "clipboard-list": ClipboardList, code: Code, "code-xml": CodeXml, coffee: Coffee, "columns-2": Columns2,
  compass: Compass, contact: Contact, database: Database, "external-link": ExternalLink, "file-code-2": FileCode2,
  "file-down": FileDown, "file-type": FileType, "folder-kanban": FolderKanban, gauge: Gauge, "grip-vertical": GripVertical, tag: Tag,
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
  baseline: Baseline, "calendar-plus": CalendarPlus, "minimize-2": Minimize2, "zoom-in": ZoomIn, "zoom-out": ZoomOut, "chevron-left": ChevronLeft,
  "move-vertical": MoveVertical, "refresh-cw": RefreshCw, "rectangle-horizontal": RectangleHorizontal, "fit-width": MoveHorizontal,
};
