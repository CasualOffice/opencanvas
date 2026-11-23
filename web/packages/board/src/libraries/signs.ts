// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Signs and symbols (DGM-14.7): generic pictograms, each our own drawing on a 100 × 100 grid.
// No text by default; a label can be typed under the glyph.
import { HEART } from "./basic";
import { G, join, type Item, type LibraryData } from "./geo";

const { R, RR, E, P, L, T, A } = G;
const BOX: [number, number, number, number] = [0, 82, 100, 18];

const sign = (name: string, label: string, keywords: string[], path: string, tone?: string): Item => ({
  name, label, base: "rect", keywords, look: { path, w: 64, h: 64, text: "", box: BOX, ...(tone ? { tone } : {}) },
});
const ring = E(50, 50, 48);
const gear = (() => {
  const pts: number[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * 45 * Math.PI) / 180, d = (11 * Math.PI) / 180;
    for (const [r, o] of [[34, -2.2 * d], [46, -d], [46, d], [34, 2.2 * d]] as const) pts.push(50 + r * Math.cos(a + o), 50 + r * Math.sin(a + o));
  }
  return join(P(...pts), E(50, 50, 14, 14, true));
})();

export const SIGNS: LibraryData = {
  id: "signs",
  name: "Signs and symbols",
  icon: "triangle-alert",
  items: [
    sign("warning", "Warning", ["caution", "alert", "danger", "hazard", "attention", "exclamation"], join(P(50, 4, 98, 92, 2, 92), R(46, 34, 8, 30), E(50, 76, 5)), "amber"),
    sign("info", "Information", ["info", "about", "help", "details", "i"], join(ring, E(50, 28, 6), R(45, 42, 10, 34)), "blue"),
    sign("question", "Question", ["help", "faq", "unknown", "ask", "query"], join(ring, "M34 38C34 26 42 20 50 20C60 20 67 27 67 36C67 46 56 48 56 58V62H44V56C44 44 55 42 55 36C55 32 53 30 50 30C46 30 46 34 46 38Z", E(50, 75, 6)), "purple"),
    sign("check", "Check", ["tick", "ok", "done", "success", "yes", "approved", "correct"], join(ring, P(24, 52, 32, 44, 44, 56, 70, 30, 78, 38, 44, 72)), "green"),
    sign("cross", "Cross", ["x", "no", "error", "wrong", "fail", "close", "cancel"], join(ring, P(30, 38, 38, 30, 50, 42, 62, 30, 70, 38, 58, 50, 70, 62, 62, 70, 50, 58, 38, 70, 30, 62, 42, 50)), "red"),
    sign("stop", "Stop", ["octagon", "halt", "stop sign", "block"], join(P(30, 2, 70, 2, 98, 30, 98, 70, 70, 98, 30, 98, 2, 70, 2, 30), P(33, 9, 67, 9, 91, 33, 91, 67, 67, 91, 33, 91, 9, 67, 9, 33)), "red"),
    sign("no-entry", "No entry", ["forbidden", "prohibited", "blocked", "do not enter", "ban"], join(ring, R(20, 42, 60, 16)), "red"),
    sign("prohibited", "Prohibited", ["ban", "not allowed", "forbidden", "none", "slash"], join(ring, E(50, 50, 36, 36, true), P(22, 30, 30, 22, 78, 70, 70, 78)), "red"),
    sign("flag", "Flag", ["milestone", "goal", "finish", "report", "mark"], join(R(16, 4, 6, 92), "M22 8C40 0 52 18 84 8V50C52 60 40 42 22 50Z")),
    sign("pin", "Location pin", ["map", "marker", "place", "location", "address", "gps"], join("M50 98C38 78 18 60 18 38A32 32 0 0 1 82 38C82 60 62 78 50 98Z", E(50, 38, 12, 12, true)), "red"),
    sign("bulb", "Light bulb", ["idea", "tip", "insight", "innovation", "lamp"], join("M36 66C36 54 22 48 22 32A28 28 0 0 1 78 32C78 48 64 54 64 66Z", R(37, 70, 26, 8), R(40, 82, 20, 8), T(42, 48, 50, 56, 58, 48)), "amber"),
    sign("gear", "Gear", ["settings", "cog", "configuration", "options", "preferences"], gear, "gray"),
    sign("lock", "Lock", ["secure", "locked", "padlock", "private", "security"], join(RR(18, 44, 64, 52, 6), "M30 44V30A20 20 0 0 1 70 30V44H60V30A10 10 0 0 0 40 30V44Z", E(50, 64, 6), R(47, 66, 6, 14))),
    sign("unlock", "Unlocked", ["open", "unlock", "padlock", "public", "unsecured"], join(RR(18, 44, 64, 52, 6), "M30 30A20 20 0 0 1 70 30V34H60V30A10 10 0 0 0 40 30V44H30Z", E(50, 64, 6), R(47, 66, 6, 14))),
    sign("key", "Key", ["password", "access", "credential", "unlock", "secret"], join(E(28, 50, 22), E(24, 50, 7, 7, true), P(48, 44, 96, 44, 96, 62, 86, 62, 86, 54, 78, 54, 78, 62, 68, 62, 68, 56, 48, 56)), "amber"),
    sign("clock", "Clock", ["time", "schedule", "hour", "deadline", "wait", "timer"], join(ring, T(50, 20, 50, 50, 70, 62), E(50, 50, 3))),
    sign("calendar", "Calendar", ["date", "schedule", "event", "day", "month", "plan"], join(RR(8, 14, 84, 80, 6), L(8, 34, 92, 34), R(26, 4, 8, 18), R(66, 4, 8, 18), R(22, 46, 12, 10), R(44, 46, 12, 10), R(66, 46, 12, 10), R(22, 66, 12, 10), R(44, 66, 12, 10))),
    sign("mail", "Mail", ["email", "envelope", "message", "letter", "inbox", "contact"], join(RR(4, 18, 92, 64, 4), T(4, 22, 50, 56, 96, 22))),
    sign("phone", "Phone", ["call", "telephone", "contact", "handset", "ring"], "M22 6C30 4 36 18 38 26C39 31 32 34 32 38C34 50 50 66 62 68C66 68 69 61 74 62C82 64 96 70 94 78C92 90 82 96 72 94C42 88 12 58 6 28C4 18 12 8 22 6Z", "green"),
    sign("home", "Home", ["house", "start", "main", "dashboard", "building"], join(P(50, 6, 96, 46, 84, 46, 84, 94, 16, 94, 16, 46, 4, 46), R(40, 62, 20, 32))),
    sign("search", "Search", ["magnifier", "find", "zoom", "look", "lens", "query"], join(E(42, 42, 30), E(42, 42, 20, 20, true), P(62, 70, 70, 62, 96, 88, 88, 96))),
    sign("star", "Star", ["favourite", "favorite", "rating", "bookmark", "important"], G.STAR(5, 50, 54, 48, 0.42), "amber"),
    sign("heart", "Heart", ["love", "like", "favourite", "health", "care"], HEART, "red"),
    sign("thumbs-up", "Thumbs up", ["like", "approve", "yes", "good", "agree", "ok"], join(RR(6, 44, 18, 50, 3), "M30 46L46 16C48 8 60 8 60 20V38H86C94 38 98 46 94 54L84 88C82 94 78 96 72 96H30Z"), "blue"),
    sign("thumbs-down", "Thumbs down", ["dislike", "disapprove", "no", "bad", "disagree"], join(RR(6, 6, 18, 50, 3), "M30 54L46 84C48 92 60 92 60 80V62H86C94 62 98 54 94 46L84 12C82 6 78 4 72 4H30Z"), "red"),
    sign("bell", "Bell", ["notification", "alert", "alarm", "reminder", "ring"], join("M50 8C30 8 24 26 24 42V62L12 76H88L76 62V42C76 26 70 8 50 8Z", "M40 82A10 10 0 0 0 60 82Z"), "amber"),
    sign("bookmark", "Bookmark", ["save", "saved", "ribbon", "favourite", "later"], P(22, 4, 78, 4, 78, 96, 50, 72, 22, 96), "purple"),
    sign("tag", "Tag", ["label", "price", "category", "badge"], join(P(4, 10, 10, 4, 52, 4, 96, 48, 48, 96, 4, 52), E(28, 28, 8, 8, true))),
    sign("shield", "Shield", ["security", "protect", "safe", "guard", "defence", "defense"], "M50 4L90 18V46C90 72 72 88 50 96C28 88 10 72 10 46V18Z", "green"),
    sign("eye", "Eye", ["view", "visible", "watch", "see", "preview", "show"], join("M2 50C18 24 34 16 50 16C66 16 82 24 98 50C82 76 66 84 50 84C34 84 18 76 2 50Z", E(50, 50, 18), E(50, 50, 7))),
    sign("chat", "Chat", ["message", "comment", "conversation", "speech", "talk", "bubble"], join("M12 8H88C94 8 96 12 96 18V62C96 68 94 72 88 72H40L18 92V72H12C6 72 4 68 4 62V18C4 12 6 8 12 8Z", L(22, 30, 78, 30), L(22, 48, 62, 48)), "blue"),
    sign("plus-circle", "Add", ["plus", "add", "new", "create", "positive"], join(ring, P(44, 24, 56, 24, 56, 44, 76, 44, 76, 56, 56, 56, 56, 76, 44, 76, 44, 56, 24, 56, 24, 44, 44, 44)), "green"),
    sign("minus-circle", "Remove", ["minus", "remove", "delete", "subtract", "negative"], join(ring, R(24, 44, 52, 12)), "red"),
    sign("download", "Download", ["save", "export", "arrow down", "get"], join(P(42, 6, 58, 6, 58, 44, 74, 44, 50, 70, 26, 44, 42, 44), T(8, 66, 8, 92, 92, 92, 92, 66))),
    sign("upload", "Upload", ["import", "send", "arrow up", "publish"], join(P(42, 70, 58, 70, 58, 32, 74, 32, 50, 6, 26, 32, 42, 32), T(8, 66, 8, 92, 92, 92, 92, 66))),
    sign("trophy", "Trophy", ["award", "winner", "prize", "achievement", "cup"], join("M28 6H72V38C72 52 62 60 50 60C38 60 28 52 28 38Z", A(28, 24, 14, 90, 270), A(72, 24, 14, -90, 90), R(46, 60, 8, 18), R(30, 78, 40, 14)), "amber"),
    sign("wifi", "Wi-Fi", ["wireless", "signal", "network", "connection", "internet"], join(E(50, 80, 7), A(50, 80, 24, 225, 315), A(50, 80, 44, 225, 315), A(50, 80, 64, 230, 310))),
    sign("power", "Power", ["on off", "shutdown", "start", "button", "switch"], join(A(50, 54, 38, -60, 240), R(45, 4, 10, 44))),
  ],
};
void A;
