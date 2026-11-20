import type { OcUser, Tone } from "@opencanvas/ui";
import type { CellValue, DbField, FieldType, ViewKind } from "./types";

export type DbPreset =
  | "blank"
  | "tasks"
  | "bugs"
  | "deals"
  | "hiring"
  | "okrs"
  | "content"
  | "reading"
  | "feedback"
  | "roadmap"
  | "actions"
  | "habits"
  | "events"
  | "onboarding"
  | "kanban";

export const DB_PRESETS: DbPreset[] = ["blank", "tasks", "bugs", "deals", "hiring", "okrs", "content", "reading", "feedback", "roadmap", "actions", "habits", "events", "onboarding", "kanban"];

/**
 * Sample people referenced by preset rows. Person values are user ids; when the host's
 * user list does not contain these ids the block falls back to this table for display.
 */
export const DEMO_PEOPLE: OcUser[] = [
  { id: "priya", name: "Priya Shah", color: "#2a5ad7" },
  { id: "asha", name: "Asha Rao", color: "#7a45f0" },
  { id: "ravi", name: "Ravi Menon", color: "#e5602a" },
  { id: "lin", name: "Lin Zhou", color: "#0e9a78" },
];

export interface PresetDef {
  name: string;
  icon: string;
  tone: Tone;
  view?: ViewKind;
  fields: DbField[];
  rows: CellValue[][];
}

type Opt = string | [string, Tone];
const F = (id: string, name: string, type: FieldType, opts?: Opt[]): DbField => {
  const f: DbField = { id, name, type };
  if (opts) f.options = opts.map((o) => (Array.isArray(o) ? { v: o[0], c: o[1] } : { v: o, c: "gray" as Tone }));
  return f;
};
const ST4: Opt[] = [["Backlog", "gray"], ["In progress", "blue"], ["In review", "amber"], ["Done", "green"]];
const me = "priya";

export const PRESETS: Record<DbPreset, PresetDef> = {
  tasks: {
    name: "Sprint 42 backlog", icon: "list-todo", tone: "blue",
    fields: [F("title", "Task", "title"), F("status", "Status", "status", ST4), F("owner", "Owner", "person"), F("due", "Due", "date"), F("pts", "Points", "number"), F("area", "Area", "tags", [["API", "purple"], ["Editor", "blue"], ["Board", "pink"], ["Infra", "gray"], ["Docs", "green"]])],
    rows: [
      ["Launch-token claims agreed with the host backend", "Done", "asha", "2026-11-17", 2, ["API"]],
      ["Role filter rejects writes from viewers", "In review", "ravi", "2026-11-24", 3, ["API", "Infra"]],
      ["Room WAL compaction every 500 updates", "In progress", "ravi", "2026-11-26", 5, ["Infra"]],
      ["Database block: table and board views", "In progress", "lin", "2026-11-27", 8, ["Editor"]],
      ["Board pointer smoothing at 60 fps", "Backlog", "lin", "2026-12-02", 3, ["Board"]],
      ["Side-panel layout for Meet", "In progress", me, "2026-11-25", 3, ["Editor"]],
      ["Integration guide: callbacks section", "Backlog", "asha", "2026-12-04", 2, ["Docs"]],
    ],
  },
  bugs: {
    name: "Bugs", icon: "bug", tone: "red",
    fields: [F("title", "Bug", "title"), F("sev", "Severity", "select", [["S1 · Critical", "red"], ["S2 · Major", "amber"], ["S3 · Minor", "gray"]]), F("status", "Status", "status", [["Triage", "gray"], ["Fixing", "blue"], ["Verifying", "amber"], ["Closed", "green"]]), F("owner", "Assignee", "person"), F("rep", "Reported", "date"), F("comp", "Component", "tags", [["Editor", "blue"], ["Sync", "purple"], ["Export", "green"], ["Mobile", "pink"]])],
    rows: [
      ["Cursor label overlaps on wrapped lines", "S3 · Minor", "Fixing", "lin", "2026-11-18", ["Editor"]],
      ["Paste from Google Docs drops table borders", "S2 · Major", "Triage", null, "2026-11-19", ["Editor"]],
      ["Reconnect loop after laptop sleep", "S1 · Critical", "Verifying", "ravi", "2026-11-16", ["Sync"]],
      ["PDF export clips wide tables", "S2 · Major", "Fixing", "asha", "2026-11-20", ["Export"]],
      ["Board toolbar hidden behind iOS keyboard", "S3 · Minor", "Closed", me, "2026-11-12", ["Mobile"]],
    ],
  },
  deals: {
    name: "Deal pipeline", icon: "handshake", tone: "green", view: "board",
    fields: [F("title", "Account", "title"), F("stage", "Stage", "status", [["Lead", "gray"], ["Qualified", "blue"], ["Proposal", "amber"], ["Negotiation", "purple"], ["Won", "green"]]), F("owner", "Owner", "person"), F("val", "Value ($)", "number"), F("close", "Close date", "date"), F("reg", "Region", "tags", [["NA", "blue"], ["EMEA", "purple"], ["APAC", "pink"]])],
    rows: [
      ["Northwind Health", "Proposal", "asha", 48000, "2026-12-12", ["NA"]],
      ["Kestrel Logistics", "Qualified", "ravi", 22000, "2027-01-08", ["EMEA"]],
      ["Arcadia Schools", "Negotiation", "asha", 96000, "2026-12-03", ["NA"]],
      ["Tamarind Foods", "Lead", "lin", 12000, "2027-01-20", ["APAC"]],
      ["Blue Fjord Energy", "Won", me, 64000, "2026-11-14", ["EMEA"]],
      ["Orbit Studios", "Lead", "ravi", 8000, "2027-02-02", ["NA"]],
    ],
  },
  hiring: {
    name: "Hiring pipeline", icon: "user-plus", tone: "purple", view: "board",
    fields: [F("title", "Candidate", "title"), F("stage", "Stage", "status", [["Applied", "gray"], ["Screen", "blue"], ["Onsite", "amber"], ["Offer", "purple"], ["Hired", "green"]]), F("role", "Role", "select", [["Senior Engineer", "blue"], ["Product Designer", "pink"], ["PM", "amber"]]), F("rec", "Recruiter", "person"), F("next", "Next step", "date"), F("score", "Score", "number")],
    rows: [
      ["Maya Okafor", "Onsite", "Senior Engineer", "asha", "2026-11-25", 4.5],
      ["Daniel Kim", "Screen", "Product Designer", "lin", "2026-11-24", null],
      ["Sofia Marques", "Offer", "PM", "asha", "2026-11-23", 4.8],
      ["Arjun Patel", "Applied", "Senior Engineer", "ravi", null, null],
      ["Hannah Weber", "Screen", "Senior Engineer", "ravi", "2026-11-26", 3.9],
    ],
  },
  okrs: {
    name: "Q1 OKRs", icon: "target", tone: "amber",
    fields: [F("title", "Key result", "title"), F("obj", "Objective", "select", [["Win integrators", "blue"], ["Delight editors", "pink"], ["Run lean", "green"]]), F("owner", "Owner", "person"), F("prog", "Progress", "progress"), F("conf", "Confidence", "status", [["On track", "green"], ["At risk", "amber"], ["Off track", "red"]]), F("due", "Due", "date")],
    rows: [
      ["3 hosts live in production", "Win integrators", "asha", 33, "On track", "2027-03-31"],
      ["Time-to-first-embed under 1 day", "Win integrators", "ravi", 60, "On track", "2027-02-28"],
      ["p95 remote latency under 150 ms", "Delight editors", "lin", 45, "At risk", "2027-03-15"],
      ["Idle node RSS under 40 MB", "Run lean", "ravi", 80, "On track", "2027-01-31"],
      ["Zero divergence incidents", "Delight editors", me, 100, "On track", "2027-03-31"],
    ],
  },
  content: {
    name: "Content calendar", icon: "calendar-days", tone: "pink", view: "calendar",
    fields: [F("title", "Title", "title"), F("status", "Status", "status", [["Idea", "gray"], ["Drafting", "blue"], ["Review", "amber"], ["Scheduled", "purple"], ["Published", "green"]]), F("ch", "Channel", "tags", [["Blog", "blue"], ["LinkedIn", "purple"], ["Newsletter", "green"], ["Video", "pink"]]), F("author", "Author", "person"), F("date", "Publish date", "date")],
    rows: [
      ["Why the file should stay in your app", "Published", ["Blog"], "asha", "2026-11-04"],
      ["Live cursors, explained", "Scheduled", ["Blog", "LinkedIn"], "lin", "2026-11-24"],
      ["November product update", "Review", ["Newsletter"], me, "2026-11-27"],
      ["Embed a canvas in 5 minutes", "Drafting", ["Video"], "ravi", "2026-12-02"],
      ["Customer story: Arcadia Schools", "Idea", ["Blog"], "asha", "2026-12-09"],
      ["Templates gallery launch", "Scheduled", ["LinkedIn"], me, "2026-11-18"],
    ],
  },
  reading: {
    name: "Reading list", icon: "book-open", tone: "green", view: "gallery",
    fields: [F("title", "Title", "title"), F("author", "Author", "text"), F("status", "Status", "status", [["To read", "gray"], ["Reading", "blue"], ["Finished", "green"]]), F("rating", "Rating", "number"), F("tags", "Topics", "tags", [["Design", "pink"], ["Systems", "purple"], ["Leadership", "amber"]])],
    rows: [
      ["Designing Data-Intensive Applications", "Martin Kleppmann", "Reading", null, ["Systems"]],
      ["The Design of Everyday Things", "Don Norman", "Finished", 5, ["Design"]],
      ["An Elegant Puzzle", "Will Larson", "To read", null, ["Leadership", "Systems"]],
      ["Thinking in Systems", "Donella Meadows", "Finished", 4, ["Systems"]],
      ["Refactoring UI", "Wathan & Schoger", "To read", null, ["Design"]],
    ],
  },
  feedback: {
    name: "Customer feedback", icon: "message-square", tone: "blue",
    fields: [F("title", "Feedback", "title"), F("cust", "Customer", "text"), F("theme", "Theme", "tags", [["Performance", "amber"], ["Mobile", "pink"], ["Export", "green"], ["Permissions", "purple"]]), F("sent", "Sentiment", "select", [["Positive", "green"], ["Neutral", "gray"], ["Negative", "red"]]), F("date", "Logged", "date"), F("owner", "Owner", "person")],
    rows: [
      ["Wants per-channel autosave settings", "Arcadia Schools", ["Permissions"], "Neutral", "2026-11-18", "asha"],
      ["Board feels instant even with 30 people", "Northwind Health", ["Performance"], "Positive", "2026-11-19", "lin"],
      ["PDF export should keep comments", "Kestrel Logistics", ["Export"], "Negative", "2026-11-20", "ravi"],
      ["Mobile checklist is great in standups", "Blue Fjord Energy", ["Mobile"], "Positive", "2026-11-20", me],
    ],
  },
  roadmap: {
    name: "Roadmap", icon: "map", tone: "purple", view: "board",
    fields: [F("title", "Initiative", "title"), F("q", "Quarter", "status", [["Q1", "blue"], ["Q2", "purple"], ["Q3", "amber"], ["Q4", "gray"]]), F("status", "Status", "select", [["Planned", "gray"], ["Building", "blue"], ["Shipped", "green"]]), F("owner", "Owner", "person"), F("impact", "Impact", "select", [["High", "red"], ["Medium", "amber"], ["Low", "gray"]])],
    rows: [
      ["Embed SDK GA", "Q1", "Building", "asha", "High"],
      ["Database block", "Q1", "Building", "lin", "High"],
      ["Comments and mentions", "Q2", "Planned", "ravi", "Medium"],
      ["Portable live blocks", "Q3", "Planned", me, "High"],
      ["DOCX import", "Q4", "Planned", null, "Low"],
    ],
  },
  actions: {
    name: "Action items", icon: "list-checks", tone: "green",
    fields: [F("title", "Action", "title"), F("owner", "Owner", "person"), F("due", "Due", "date"), F("done", "Done", "checkbox")],
    rows: [
      ["Send recap to the channel", me, "2026-11-21", true],
      ["Book a design review for the board block", "lin", "2026-11-25", false],
      ["Confirm Meet side-panel width", "ravi", "2026-11-24", false],
    ],
  },
  habits: {
    name: "Habit tracker", icon: "repeat", tone: "green",
    fields: [F("title", "Day", "title"), F("ex", "Exercise", "checkbox"), F("read", "Read 20 min", "checkbox"), F("med", "Meditate", "checkbox"), F("sleep", "Sleep (h)", "number")],
    rows: [
      ["Mon, Nov 16", true, true, false, 7.5],
      ["Tue, Nov 17", false, true, true, 6.5],
      ["Wed, Nov 18", true, false, true, 8],
      ["Thu, Nov 19", true, true, true, 7],
      ["Fri, Nov 20", false, true, false, 6],
    ],
  },
  events: {
    name: "Event tasks", icon: "party-popper", tone: "pink",
    fields: [F("title", "Task", "title"), F("status", "Status", "status", ST4), F("owner", "Owner", "person"), F("due", "Due", "date"), F("budget", "Budget ($)", "number")],
    rows: [
      ["Book venue", "Done", "asha", "2026-11-10", 4200],
      ["Speaker lineup", "In progress", me, "2026-11-28", 0],
      ["Catering order", "Backlog", "ravi", "2026-12-05", 1800],
      ["Swag and badges", "In review", "lin", "2026-12-01", 950],
    ],
  },
  onboarding: {
    name: "Onboarding plan", icon: "clipboard-list", tone: "blue",
    fields: [F("title", "Task", "title"), F("week", "Week", "select", [["Week 1", "blue"], ["Week 2", "purple"], ["Week 3", "amber"], ["Week 4", "green"]]), F("owner", "Buddy", "person"), F("done", "Done", "checkbox"), F("link", "Link", "url")],
    rows: [
      ["Set up laptop and accounts", "Week 1", "ravi", true, "https://wiki.example.com/setup"],
      ["Read the architecture docs", "Week 1", "asha", false, "https://wiki.example.com/hld"],
      ["Ship a small fix", "Week 2", "lin", false, ""],
      ["Shadow an on-call shift", "Week 3", "ravi", false, ""],
      ["30-day check-in", "Week 4", me, false, ""],
    ],
  },
  blank: {
    name: "Untitled database", icon: "database", tone: "gray",
    fields: [F("title", "Name", "title"), F("status", "Status", "status", [["Not started", "gray"], ["In progress", "blue"], ["Done", "green"]]), F("owner", "Owner", "person"), F("date", "Date", "date")],
    rows: [
      ["", "Not started", null, null],
      ["", "Not started", null, null],
      ["", "Not started", null, null],
    ],
  },
  kanban: {
    name: "Kanban", icon: "square-kanban", tone: "blue", view: "board",
    fields: [F("title", "Card", "title"), F("status", "Status", "status", [["To do", "gray"], ["Doing", "blue"], ["Review", "amber"], ["Done", "green"]]), F("owner", "Owner", "person"), F("due", "Due", "date")],
    rows: [
      ["Collect requirements", "Done", "asha", "2026-11-18"],
      ["Draft the plan", "Doing", me, "2026-11-24"],
      ["Review with stakeholders", "To do", "ravi", "2026-11-27"],
      ["Kickoff", "To do", null, "2026-12-01"],
    ],
  },
};
