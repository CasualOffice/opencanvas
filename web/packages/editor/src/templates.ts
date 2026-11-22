// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Built-in templates (TPL-02), ported from the approved UI-02 prototype.
import type { Tone } from "@opencanvas/ui";
import {
  BOARD, BUL, CALL, CODE, COLS, DB, EMBED, H2, H3, IMG, LINK, NUM, P, QUOTE, TABLE, TODO, TOG, type DbPreset, type TB,
} from "./editor/content";

export const CATS: [id: string, name: string, icon: string][] = [
  ["all", "All templates", "layout-grid"],
  ["meetings", "Meetings", "users-round"],
  ["projects", "Projects", "folder-kanban"],
  ["product", "Product & engineering", "code-xml"],
  ["design", "Design & research", "pen-tool"],
  ["team", "Team & HR", "heart-handshake"],
  ["sales", "Sales & success", "handshake"],
  ["planning", "Planning", "calendar-range"],
  ["boards", "Whiteboards", "shapes"],
  ["personal", "Personal", "sparkles"],
];

export interface Template {
  id: string;
  cat: string;
  name: string;
  icon: string;
  tone: Tone;
  desc: string;
  blocks: TB[];
}

const T = (id: string, cat: string, name: string, icon: string, tone: Tone, desc: string, blocks: TB[]): Template => ({ id, cat, name, icon, tone, desc, blocks });

export const TPL: Template[] = [
  T("meeting", "meetings", "Meeting notes", "notebook-pen", "blue", "Agenda, notes, decisions and action items for any meeting.", [CALL("gray", "calendar", "<b>When:</b> Thu, Nov 26 · 10:00 · <b>Where:</b> Meet"), H2("Agenda"), NUM(["Updates since last week", "Decide the autosave default", "Open questions"]), H2("Notes"), P(""), H2("Decisions"), BUL([""]), H2("Action items"), DB("actions")]),
  T("oneonone", "meetings", "1:1 notes", "users-round", "purple", "A running doc for weekly one-on-ones, with talking points and follow-ups.", [H2("Talking points"), TODO(["How is the new on-call rotation going?", "Feedback on the design review", "Career goals for next quarter"]), COLS({ h: "Wins", items: ["Shipped the role filter"] }, { h: "Blockers", items: ["Waiting on staging access"] }), H2("Follow-ups"), TODO([["Share the growth framework", false, "me", "2026-11-27"]])]),
  T("standup", "meetings", "Daily standup", "coffee", "amber", "Fifteen minutes, three questions, and blockers that get owners.", [CALL("amber", "clock", "Time-box: 15 minutes. Take long discussions offline."), H3("Yesterday"), BUL([""]), H3("Today"), BUL([""]), H3("Blockers"), TODO([""])]),
  T("retro", "meetings", "Sprint retrospective", "repeat", "green", "A board for went well, to improve and ideas, plus owned action items.", [P("Add stickies to each column, then vote. The top three become actions."), BOARD("brainstorm"), H2("Actions"), DB("actions")]),
  T("allhands", "meetings", "All-hands agenda", "megaphone", "pink", "A timed agenda, questions from the team and the recording.", [NUM(["<b>10:00</b> · Welcome and wins", "<b>10:10</b> · Product update", "<b>10:30</b> · Customer story", "<b>10:45</b> · Q&amp;A"]), H2("Questions from the team"), TODO(["When is the mobile app coming?", "How do we pick what goes on the roadmap?"]), EMBED("youtube", "", "All-hands recording")]),
  T("brainstorm", "meetings", "Brainstorm session", "lightbulb", "amber", "Diverge on a board, then converge on a shortlist.", [CALL("blue", "info", "<b>Prompt:</b> How might we make the first canvas feel effortless?"), BOARD("brainstorm"), H2("Shortlist"), TODO(["", "", ""])]),
  T("brief", "projects", "Project brief", "file-text", "blue", "Problem, goals, scope, milestones and team on one page.", [CALL("blue", "target", "<b>Goal:</b> one sentence on the outcome."), H2("Problem"), P(""), COLS({ h: "Goals", items: ["", ""] }, { h: "Non-goals", items: ["", ""] }), H2("Milestones"), TODO([["Kickoff", false, null, "2026-12-01"], ["Beta", false, null, "2027-01-15"], ["Launch", false, null, "2027-02-20"]]), H2("Team"), BUL(["Lead: ", "Design: ", "Engineering: "])]),
  T("tracker", "projects", "Project tracker", "list-todo", "blue", "A task database with status, owners, dates and points.", [DB("tasks")]),
  T("roadmap", "projects", "Product roadmap", "map", "purple", "Initiatives grouped by quarter on a board, with impact and owners.", [DB("roadmap")]),
  T("launch", "projects", "Launch plan", "rocket", "pink", "Checklist, timeline and messaging for a launch.", [H2("Checklist"), TODO(["Pricing page updated", "Docs published", "Support briefed", "Announcement scheduled"]), H2("Timeline"), DB("content", "calendar"), H2("Messaging"), QUOTE("One line that says what changes for the customer.")]),
  T("sprint", "projects", "Sprint planning", "gauge", "green", "Goal, capacity and the sprint backlog.", [CALL("green", "target", "<b>Sprint goal:</b> "), TABLE([["Person", "Days", "Focus"], ["Asha", "9", "API"], ["Ravi", "8", "Infra"], ["Lin", "10", "Editor"]]), H2("Backlog"), DB("tasks")]),
  T("bugs", "projects", "Bug tracker", "bug", "red", "Severity, status, assignee and component in one database.", [DB("bugs")]),
  T("prd", "product", "Product requirements", "scroll-text", "blue", "Problem, users, requirements, metrics and open questions.", [H2("Problem"), P(""), H2("Users"), BUL(["", ""]), H2("Requirements"), TODO(["Must: ", "Should: ", "Could: "]), H2("Success metrics"), TABLE([["Metric", "Today", "Target"], ["", "", ""]]), TOG("Open questions", [""])]),
  T("rfc", "product", "Technical spec (RFC)", "code-xml", "purple", "Context, proposal, alternatives and rollout.", [CALL("gray", "info", "<b>Status:</b> Draft · <b>Reviewers:</b> "), H2("Context"), P(""), H2("Proposal"), P(""), CODE("ts", 'interface Grant { host: string; role: "view" | "comment" | "edit" }'), TOG("Alternatives considered", [""]), H2("Rollout"), NUM(["Behind a flag", "10% of hosts", "Everyone"])]),
  T("postmortem", "product", "Incident postmortem", "siren", "red", "Blameless summary, timeline, root cause and follow-ups.", [CALL("red", "triangle-alert", "<b>Impact:</b> 14 minutes of failed saves for 3% of rooms. No data lost."), H2("Timeline"), TABLE([["Time (UTC)", "Event"], ["09:02", "Deploy 0.4.1 starts"], ["09:05", "Save errors alert"], ["09:16", "Rollback complete"]]), H2("Root cause"), P(""), H2("Follow-ups"), DB("actions")]),
  T("release", "product", "Release notes", "badge-check", "green", "New, improved and fixed, ready to share.", [H2("New"), BUL(["Database block with table, board, calendar and gallery views"]), H2("Improved"), BUL(["Cursor labels no longer overlap"]), H2("Fixed"), BUL(["Reconnect loop after sleep"])]),
  T("api", "product", "API reference", "file-code-2", "gray", "Endpoints with requests, responses and errors.", [H2("Create a session"), CODE("http", 'POST /v1/launch\ntoken="eyJhbGciOi…"'), H2("Errors"), TABLE([["Code", "Meaning"], ["401", "Token invalid or expired"], ["409", "File changed outside the session"]])]),
  T("critique", "design", "Design critique", "palette", "pink", "Share the work, collect what works and what to change.", [IMG("Paste the design here", "ui"), H2("What works"), BUL([""]), H2("What to change"), TODO(["", ""]), H2("Decision"), P("")]),
  T("interview", "design", "User interview notes", "contact", "purple", "Participant, quotes, insights and a feedback log.", [TABLE([["Participant", "Role", "Date"], ["P4", "Ops lead", "Nov 19"]]), H2("Key quotes"), QUOTE("“I just want to paste the meeting notes and have everyone see them.”"), H2("Insights"), BUL([""]), H2("Feedback log"), DB("feedback")]),
  T("moodboard", "design", "Moodboard", "image", "amber", "Colours, references and words on a free-form board.", [BOARD("moodboard")]),
  T("journey", "design", "User journey map", "route", "green", "Stages, actions and pain points across the journey.", [BOARD("journey"), H2("Opportunities"), TODO(["", ""])]),
  T("onboarding", "team", "Onboarding checklist", "clipboard-list", "blue", "A first-month plan with buddies, links and progress.", [CALL("green", "sparkles", "Welcome to the team. This page is yours. Tick things off as you go."), DB("onboarding")]),
  T("wiki", "team", "Team wiki", "book-marked", "gray", "Who we are, how we work and where to find things.", [H2("About the team"), P(""), H2("Rituals"), TABLE([["Ritual", "When", "Owner"], ["Standup", "Daily 10:00", "Rotating"], ["Demo", "Friday 16:00", "Lin"]]), H2("Tools"), LINK("https://docs.example.com", "Engineering handbook", "How we build, review and ship.", "docs.example.com")]),
  T("hiring", "team", "Hiring pipeline", "user-plus", "purple", "Candidates by stage, with recruiter, next step and score.", [DB("hiring")]),
  T("scorecard", "team", "Interview scorecard", "list-checks", "amber", "Competencies, evidence and a clear recommendation.", [TABLE([["Competency", "Score (1–5)", "Evidence"], ["Problem solving", "", ""], ["Communication", "", ""], ["Ownership", "", ""]]), H2("Recommendation"), CALL("gray", "scale", "Strong yes · Yes · No · Strong no"), H2("Notes"), P("")]),
  T("okrs", "team", "OKRs", "target", "amber", "Objectives, key results, progress and confidence.", [DB("okrs")]),
  T("pipeline", "sales", "Deal pipeline", "handshake", "green", "Deals by stage with value, owner and close date.", [DB("deals")]),
  T("account", "sales", "Account plan", "briefcase", "blue", "Goals, stakeholders and next steps for a key account.", [COLS({ h: "Goals", items: ["Expand to 3 teams", "Renew in March"] }, { h: "Risks", items: ["New CIO", "Budget freeze"] }), H2("Stakeholders"), TABLE([["Name", "Role", "Stance"], ["", "Champion", ""], ["", "Economic buyer", ""]]), H2("Next steps"), TODO(["", ""])]),
  T("feedback", "sales", "Customer feedback log", "message-square", "blue", "Every piece of feedback, tagged by theme and sentiment.", [DB("feedback")]),
  T("callrecap", "sales", "Customer call recap", "phone", "pink", "Summary, pains, and next steps to send after a call.", [CALL("gray", "phone", "<b>Call with</b> Northwind Health · Nov 20"), H2("Summary"), P(""), H2("Pains"), BUL(["", ""]), H2("Next steps"), TODO([""])]),
  T("weekly", "planning", "Weekly plan", "calendar", "blue", "Top priorities, the week at a glance and notes.", [H2("Top 3"), TODO(["", "", ""]), TABLE([["Mon", "Tue", "Wed", "Thu", "Fri"], ["", "", "", "", ""]]), H2("Notes"), P("")]),
  T("quarterly", "planning", "Quarterly planning", "calendar-range", "purple", "Themes, OKRs, and risks for the quarter.", [COLS({ h: "Themes", items: ["Integrators", "Editors"] }, { h: "Constraints", items: ["Hiring freeze", "Two releases"] }), DB("okrs"), TOG("Risks", [""])]),
  T("contentcal", "planning", "Content calendar", "calendar-days", "pink", "Posts by date and channel on a calendar view.", [DB("content")]),
  T("event", "planning", "Event plan", "party-popper", "amber", "Details, tasks and budget for an event.", [CALL("amber", "map-pin", "<b>Where:</b> · <b>When:</b> · <b>Guests:</b>"), DB("events"), H2("Run of show"), NUM(["", ""])]),
  T("mindmap", "boards", "Mind map", "network", "purple", "A central idea with branches you can grow.", [BOARD("mindmap")]),
  T("flowchart", "boards", "Flowchart", "workflow", "blue", "Start, steps, decisions and outcomes.", [BOARD("flowchart")]),
  T("kanban", "boards", "Kanban board", "square-kanban", "green", "To do, doing, review, done, with drag and drop.", [DB("kanban")]),
  T("reading", "personal", "Reading list", "book-open", "green", "Books by status, with ratings and topics.", [DB("reading")]),
  T("habits", "personal", "Habit tracker", "repeat", "amber", "Daily check-ins and sleep in one table.", [DB("habits")]),
  T("trip", "personal", "Trip planner", "plane", "blue", "Itinerary, packing list and bookings.", [TABLE([["Day", "Plan", "Stay"], ["Fri", "Fly to Lisbon", "Alfama"], ["Sat", "Sintra day trip", "Alfama"]]), H2("Packing"), TODO(["Passport", "Adapter", "Rain jacket"]), LINK("https://maps.example.com", "Saved places", "12 places · Lisbon", "maps.example.com")]),
];

export const STARTS: [id: "blank" | "dbblank" | "boardblank" | "import", name: string, desc: string, icon: string, tone: Tone][] = [
  ["blank", "Blank canvas", "Start from an empty page", "file-text", "gray"],
  ["dbblank", "Database", "Table, board, calendar, gallery", "database", "blue"],
  ["boardblank", "Whiteboard", "An infinite board to sketch on", "shapes", "purple"],
  ["import", "Import", "Markdown, HTML or CSV", "upload", "green"],
];

/** What the gallery needs to draw a database preset without creating it. */
export const DB_INFO: Record<DbPreset, { name: string; view: "table" | "board" | "calendar" | "gallery"; fields: number; groups: string[]; rows: number }> = {
  blank: { name: "Untitled database", view: "table", fields: 4, groups: ["gray", "blue", "green"], rows: 3 },
  tasks: { name: "Sprint 42 backlog", view: "table", fields: 6, groups: ["gray", "blue", "amber", "green"], rows: 7 },
  bugs: { name: "Bugs", view: "table", fields: 6, groups: ["gray", "blue", "amber", "green"], rows: 5 },
  deals: { name: "Deal pipeline", view: "board", fields: 6, groups: ["gray", "blue", "amber", "purple", "green"], rows: 6 },
  hiring: { name: "Hiring pipeline", view: "board", fields: 6, groups: ["gray", "blue", "amber", "purple", "green"], rows: 5 },
  okrs: { name: "Q1 OKRs", view: "table", fields: 6, groups: ["green", "amber", "red"], rows: 5 },
  content: { name: "Content calendar", view: "calendar", fields: 5, groups: ["gray", "blue", "amber", "purple", "green"], rows: 6 },
  reading: { name: "Reading list", view: "gallery", fields: 5, groups: ["gray", "blue", "green"], rows: 5 },
  feedback: { name: "Customer feedback", view: "table", fields: 6, groups: [], rows: 4 },
  roadmap: { name: "Roadmap", view: "board", fields: 5, groups: ["blue", "purple", "amber", "gray"], rows: 5 },
  actions: { name: "Action items", view: "table", fields: 4, groups: [], rows: 3 },
  habits: { name: "Habit tracker", view: "table", fields: 5, groups: [], rows: 5 },
  events: { name: "Event tasks", view: "table", fields: 5, groups: ["gray", "blue", "amber", "green"], rows: 4 },
  onboarding: { name: "Onboarding plan", view: "table", fields: 5, groups: ["blue", "purple", "amber", "green"], rows: 5 },
  kanban: { name: "Kanban", view: "board", fields: 4, groups: ["gray", "blue", "amber", "green"], rows: 4 },
};

/** Approximate starter shapes per board preset, for gallery thumbnails. */
export const BOARD_THUMB: Record<string, { x: number; y: number; w: number; h: number; f: string; round?: boolean }[]> = {
  blank: [],
  flow: [{ x: 30, y: 40, w: 250, h: 170, f: "box" }, { x: 56, y: 84, w: 190, h: 96, f: "y" }, { x: 340, y: 84, w: 150, h: 110, f: "b" }, { x: 550, y: 84, w: 150, h: 110, f: "p" }],
  brainstorm: [{ x: 30, y: 62, w: 150, h: 110, f: "g" }, { x: 30, y: 184, w: 150, h: 110, f: "g" }, { x: 270, y: 62, w: 150, h: 110, f: "p" }, { x: 270, y: 184, w: 150, h: 110, f: "p" }, { x: 510, y: 62, w: 150, h: 110, f: "b" }, { x: 510, y: 184, w: 150, h: 110, f: "y" }],
  mindmap: [{ x: 290, y: 170, w: 170, h: 74, f: "box", round: true }, { x: 60, y: 40, w: 130, h: 48, f: "box" }, { x: 60, y: 300, w: 130, h: 48, f: "box" }, { x: 560, y: 40, w: 130, h: 48, f: "box" }, { x: 560, y: 300, w: 130, h: 48, f: "box" }, { x: 310, y: 10, w: 130, h: 48, f: "box" }, { x: 310, y: 330, w: 130, h: 48, f: "box" }],
  journey: [0, 1, 2, 3, 4].flatMap((i) => [{ x: 20 + i * 150, y: 30, w: 136, h: 44, f: "box" }, { x: 20 + i * 150, y: 92, w: 136, h: 96, f: ["b", "y", "g", "p", "g"][i] }, { x: 20 + i * 150, y: 200, w: 136, h: 90, f: "p" }]),
  moodboard: [{ x: 30, y: 30, w: 200, h: 150, f: "accent" }, { x: 250, y: 30, w: 150, h: 150, f: "amber" }, { x: 420, y: 30, w: 240, h: 100, f: "green" }, { x: 420, y: 150, w: 110, h: 130, f: "pink" }, { x: 550, y: 150, w: 110, h: 130, f: "purple" }, { x: 30, y: 250, w: 190, h: 90, f: "y" }, { x: 250, y: 200, w: 150, h: 90, f: "b" }],
  flowchart: [{ x: 270, y: 20, w: 160, h: 56, f: "box", round: true }, { x: 260, y: 110, w: 180, h: 60, f: "box" }, { x: 270, y: 200, w: 160, h: 100, f: "box" }, { x: 540, y: 222, w: 150, h: 56, f: "box" }, { x: 10, y: 222, w: 150, h: 56, f: "box" }],
};
