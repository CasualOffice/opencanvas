// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Network and cloud, generic (DGM-14.7). No vendor or brand shapes (owner policy): every glyph is
// our own drawing. Box kinds from step 1 (server … client) never change; the new kinds are a
// glyph above a label (label box under the glyph).
import { CLOUD, CYLINDER } from "./basic";
import { G, join, type Item, type LibraryData } from "./geo";

const { R, RR, E, P, L, T, A } = G;
const LABEL: [number, number, number, number] = [0, 70, 100, 30];

/** A glyph tile: square, glyph in the top 66 %, text under it. */
const glyph = (name: string, label: string, keywords: string[], path: string, tone?: string, text = label): Item => ({
  name, label, base: "rect", keywords, look: { path, w: 96, h: 96, text, box: LABEL, ...(tone ? { tone } : {}) },
});

const person = (cx: number, s = 1) => join(E(cx, 18 * s + 4, 11 * s), `M${cx - 22 * s} ${62}C${cx - 22 * s} ${44} ${cx - 12 * s} ${36} ${cx} ${36}C${cx + 12 * s} ${36} ${cx + 22 * s} ${44} ${cx + 22 * s} ${62}Z`);
const globe = (cx: number, cy: number, r: number) => join(E(cx, cy, r), E(cx, cy, r * 0.45, r), L(cx - r, cy, cx + r, cy), A(cx, cy - r * 0.35, r * 0.95, 200, 340), L(cx, cy - r, cx, cy + r));
const hex = (cx: number, cy: number, r: number) => G.REG(6, cx, cy, r, -90);

export const NETWORK: LibraryData = {
  id: "network",
  name: "Network and cloud",
  icon: "network",
  items: [
    { name: "server", label: "Server", base: "rect", keywords: ["host", "machine", "vm", "node", "compute", "instance"], look: { path: "M0 0H100V100H0Z M8 18H30 M8 30H30", w: 150, h: 70 } },
    { name: "database", label: "Database", base: "rect", keywords: ["db", "sql", "postgres", "mysql", "storage", "data", "rdbms"], look: { path: CYLINDER, w: 120, h: 90, tone: "green", box: [0, 26, 100, 66] } },
    { name: "load-balancer", label: "Load balancer", base: "rect", keywords: ["lb", "proxy", "ingress", "traffic", "balancer"], look: { path: "M0 0H100V100H0Z M50 15V40 M50 40L25 85 M50 40L75 85", w: 150, h: 70, tone: "purple" } },
    { name: "service", label: "Service", base: "rect", keywords: ["microservice", "app", "api", "backend"], look: { w: 150, h: 70, tone: "blue" } },
    { name: "api-gateway", label: "API gateway", base: "rect", keywords: ["gateway", "api", "edge", "ingress"], look: { path: "M10 0H90L100 50L90 100H10L0 50Z", w: 160, h: 70, tone: "blue", box: [8, 0, 84, 100] } },
    { name: "cloud", label: "Cloud", base: "rect", keywords: ["internet", "external", "saas", "vpc", "region"], look: { path: CLOUD, w: 160, h: 100, box: [16, 30, 70, 50] } },
    { name: "queue", label: "Queue", base: "rect", keywords: ["topic", "kafka", "stream", "message", "bus", "events", "mq", "pubsub"], look: { path: "M12 0H88C104 0 104 100 88 100H12C-4 100 -4 0 12 0Z M88 0C72 0 72 100 88 100", w: 160, h: 60, tone: "amber", box: [4, 0, 76, 100] } },
    { name: "cache", label: "Cache", base: "rect", keywords: ["redis", "memcached", "memory", "data", "kv"], look: { path: "M25 0H75L100 50L75 100H25L0 50Z", w: 140, h: 70, tone: "red", box: [18, 0, 64, 100] } },
    { name: "client", label: "Client", base: "rect", keywords: ["browser", "user", "app", "device", "web", "mobile", "frontend"], look: { path: "M0 0H100V78H0Z M35 100H65 M50 78V100", w: 140, h: 90, box: [0, 0, 100, 78] } },
    glyph("rack", "Rack", ["rack", "cabinet", "servers", "data centre", "datacenter"], join(R(30, 2, 40, 64), R(34, 7, 32, 10), R(34, 21, 32, 10), R(34, 35, 32, 10), R(34, 49, 32, 10), L(38, 12, 46, 12), L(38, 26, 46, 26), L(38, 40, 46, 40), L(38, 54, 46, 54))),
    glyph("storage", "Storage", ["disk", "array", "san", "nas", "volume", "block storage", "drive"], join(RR(16, 4, 68, 18, 3), RR(16, 25, 68, 18, 3), RR(16, 46, 68, 18, 3), E(72, 13, 2.5), E(72, 34, 2.5), E(72, 55, 2.5), L(24, 13, 50, 13), L(24, 34, 50, 34), L(24, 55, 50, 55)), "green"),
    glyph("object-storage", "Object storage", ["bucket", "blob", "files", "s3", "objects"], join("M18 8H82L74 64H26Z", E(50, 8, 32, 6), L(34, 30, 66, 30)), "green"),
    glyph("firewall", "Firewall", ["security", "waf", "filter", "wall", "acl", "bricks"], join(R(12, 6, 76, 58), L(12, 20.5, 88, 20.5), L(12, 35, 88, 35), L(12, 49.5, 88, 49.5), L(36, 6, 36, 20.5), L(64, 6, 64, 20.5), L(24, 20.5, 24, 35), L(50, 20.5, 50, 35), L(76, 20.5, 76, 35), L(36, 35, 36, 49.5), L(64, 35, 64, 49.5), L(24, 49.5, 24, 64), L(50, 49.5, 50, 64), L(76, 49.5, 76, 64)), "red"),
    glyph("router", "Router", ["routing", "gateway", "network", "wan"], join(E(50, 34, 30), T(36, 34, 64, 34), T(50, 20, 50, 48), P(64, 34, 58, 30, 58, 38), P(36, 34, 42, 30, 42, 38), P(50, 20, 46, 26, 54, 26), P(50, 48, 46, 42, 54, 42))),
    glyph("switch", "Switch", ["network switch", "lan", "ethernet", "l2"], join(RR(8, 18, 84, 34, 4), T(26, 29, 70, 29), P(76, 29, 68, 25, 68, 33), T(74, 41, 30, 41), P(24, 41, 32, 37, 32, 45))),
    glyph("hub", "Hub", ["network hub", "lan", "repeater", "ports"], join(RR(8, 22, 84, 26, 4), R(16, 38, 8, 6), R(30, 38, 8, 6), R(44, 38, 8, 6), R(58, 38, 8, 6), R(72, 38, 8, 6), L(20, 22, 20, 8), L(50, 22, 50, 8), L(80, 22, 80, 8))),
    glyph("access-point", "Access point", ["wifi", "wireless", "wlan", "hotspot", "ap"], join(E(50, 52, 5), A(50, 52, 16, 225, 315), A(50, 52, 30, 225, 315), A(50, 52, 44, 225, 315), L(50, 57, 50, 66))),
    glyph("internet", "Internet", ["web", "www", "globe", "world", "public", "online"], globe(50, 34, 30), "blue"),
    glyph("laptop", "Laptop", ["notebook", "computer", "pc", "workstation", "client"], join(RR(20, 10, 60, 40, 3), R(25, 15, 50, 30), P(8, 50, 92, 50, 98, 60, 2, 60))),
    glyph("desktop", "Desktop", ["pc", "computer", "workstation", "monitor", "client"], join(RR(12, 4, 76, 46, 3), R(17, 9, 66, 36), P(42, 50, 58, 50, 61, 60, 39, 60), L(32, 62, 68, 62))),
    glyph("phone", "Phone", ["mobile", "smartphone", "cell", "ios", "android", "handset"], join(RR(34, 2, 32, 62, 5), L(46, 57, 54, 57), L(44, 7, 56, 7))),
    glyph("tablet", "Tablet", ["ipad", "pad", "mobile", "device"], join(RR(22, 4, 56, 60, 5), R(27, 10, 46, 46), E(50, 60, 1.8))),
    glyph("printer", "Printer", ["print", "printing", "copier", "output"], join(R(26, 4, 48, 18), RR(10, 22, 80, 28, 4), R(26, 40, 48, 24), L(32, 48, 68, 48), L(32, 56, 60, 56), E(80, 30, 2))),
    glyph("user", "User", ["person", "people", "account", "customer", "human", "member"], person(50)),
    glyph("users", "Users", ["people", "group", "team", "accounts", "customers", "persons"], join(E(66, 18, 9), "M78 58C80 48 76 34 64 34", person(40))),
    glyph("gateway", "Gateway", ["edge", "entry", "nat", "ingress", "egress", "gate"], join(P(14, 64, 14, 20, 50, 4, 86, 20, 86, 64), R(34, 30, 32, 34), T(14, 20, 86, 20)), "blue"),
    glyph("api", "API", ["endpoint", "rest", "graphql", "interface", "http", "rpc"], join(RR(10, 8, 80, 54, 6), "M36 18C28 18 30 24 30 30C30 33 28 35 24 35C28 35 30 37 30 40C30 46 28 52 36 52", "M64 18C72 18 70 24 70 30C70 33 72 35 76 35C72 35 70 37 70 40C70 46 72 52 64 52"), "blue"),
    glyph("message-queue", "Message queue", ["queue", "mq", "broker", "messages", "fifo", "pubsub"], join(RR(6, 18, 88, 34, 4), R(14, 25, 14, 20), R(32, 25, 14, 20), R(50, 25, 14, 20), P(72, 26, 86, 35, 72, 44)), "amber"),
    glyph("memory-cache", "Cache node", ["cache", "redis", "memory", "ram", "in-memory"], join(RR(12, 14, 76, 40, 4), L(22, 14, 22, 6), L(36, 14, 36, 6), L(50, 14, 50, 6), L(64, 14, 64, 6), L(78, 14, 78, 6), L(22, 54, 22, 62), L(36, 54, 36, 62), L(50, 54, 50, 62), L(64, 54, 64, 62), L(78, 54, 78, 62), P(54, 20, 40, 36, 50, 36, 46, 48, 60, 32, 50, 32)), "red"),
    glyph("cdn", "CDN", ["content delivery", "edge", "cache", "distribution", "pop"], join(E(50, 34, 12), E(16, 14, 7), E(84, 14, 7), E(16, 54, 7), E(84, 54, 7), L(22, 18, 40, 28), L(78, 18, 60, 28), L(22, 50, 40, 40), L(78, 50, 60, 40)), "purple"),
    glyph("dns", "DNS", ["domain", "name server", "resolver", "lookup", "address"], join(globe(36, 34, 24), RR(58, 24, 36, 22, 3), L(64, 32, 88, 32), L(64, 38, 80, 38)), "purple"),
    glyph("vpn", "VPN", ["tunnel", "secure", "private network", "ipsec", "wireguard"], join("M50 2L82 12V32C82 50 68 60 50 66C32 60 18 50 18 32V12Z", RR(38, 30, 24, 18, 2), "M42 30V24C42 16 58 16 58 24V30"), "green"),
    glyph("container", "Container", ["docker", "oci", "image", "box", "runtime"], join(P(50, 4, 84, 18, 84, 52, 50, 66, 16, 52, 16, 18), T(16, 18, 50, 32, 84, 18), L(50, 32, 50, 66)), "blue"),
    glyph("pod", "Pod", ["kubernetes", "k8s", "workload", "replica", "hexagon"], join(hex(50, 34, 30), P(50, 22, 62, 28, 62, 42, 50, 48, 38, 42, 38, 28), T(38, 28, 50, 34, 62, 28), L(50, 34, 50, 48)), "blue"),
    glyph("cluster", "Cluster", ["kubernetes", "k8s", "nodes", "group", "pool", "hexagons"], join(hex(30, 22, 16), hex(70, 22, 16), hex(50, 50, 16)), "blue"),
    glyph("function", "Function", ["serverless", "lambda", "faas", "code", "trigger"], join(RR(14, 4, 72, 60, 8), P(34, 14, 44, 14, 66, 54, 56, 54, 49, 40, 40, 54, 30, 54, 44, 30, 40, 22, 34, 22)), "amber"),
    glyph("monitoring", "Monitoring", ["monitor", "metrics", "observability", "alerting", "dashboard", "health"], join(RR(8, 6, 84, 50, 4), T(14, 36, 30, 36, 38, 20, 48, 48, 58, 26, 64, 36, 86, 36), L(40, 64, 60, 64), L(50, 56, 50, 64)), "green"),
    glyph("mail-server", "Mail server", ["email", "smtp", "mail", "imap", "inbox"], join(R(14, 14, 72, 44), T(14, 14, 50, 40, 86, 14))),
    glyph("key-vault", "Secrets", ["vault", "keys", "secret", "kms", "credentials", "password"], join(RR(14, 8, 72, 56, 6), E(42, 36, 10), T(52, 36, 74, 36, 74, 44), L(66, 36, 66, 42)), "amber"),
  ],
};
