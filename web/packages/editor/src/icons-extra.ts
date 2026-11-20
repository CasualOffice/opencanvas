// Icons used by templates, the gallery and the icon picker. Loaded on demand
// by icons.tsx so they stay out of the initial bundle.
import {
  AlignLeft, ArrowLeft, ArrowRight, BadgeCheck, Bell, BookMarked, BookOpen, Briefcase, Bug, CalendarDays,
  CalendarRange, ClipboardList, Coffee, Compass, Contact, FileCode2, FolderKanban, Gauge, Handshake, Hash, Heart,
  HeartHandshake, LayoutGrid, ListChecks, Map as MapIcon, Megaphone, NotebookPen, Palette, PartyPopper, Phone,
  Plane, Repeat, Route, Scale, ScrollText, Search, Siren, Smartphone, Smile, Square, SquareCheck, SquareKanban,
  Undo2, UserPlus, UserRound, Users, Workflow, Zap,
  type LucideIcon,
} from "lucide-react";

export const EXTRA: Record<string, LucideIcon> = {
  "align-left": AlignLeft, "arrow-left": ArrowLeft, "arrow-right": ArrowRight, "badge-check": BadgeCheck,
  bell: Bell, "book-marked": BookMarked, "book-open": BookOpen, briefcase: Briefcase, bug: Bug,
  "calendar-days": CalendarDays, "calendar-range": CalendarRange, "clipboard-list": ClipboardList, coffee: Coffee,
  compass: Compass, contact: Contact, "file-code-2": FileCode2, "folder-kanban": FolderKanban, gauge: Gauge,
  handshake: Handshake, hash: Hash, heart: Heart, "heart-handshake": HeartHandshake, "layout-grid": LayoutGrid,
  "list-checks": ListChecks, map: MapIcon, megaphone: Megaphone, "notebook-pen": NotebookPen, palette: Palette,
  "party-popper": PartyPopper, phone: Phone, plane: Plane, repeat: Repeat, route: Route, scale: Scale,
  "scroll-text": ScrollText, search: Search, siren: Siren, smartphone: Smartphone, smile: Smile, square: Square,
  "square-check": SquareCheck, "square-kanban": SquareKanban, "undo-2": Undo2, "user-plus": UserPlus,
  "user-round": UserRound, users: Users, workflow: Workflow, zap: Zap,
};
