#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice
"""Builds the OpenCanvas Grafana dashboard (OPS-01).

    python3 deploy/monitoring/build-dashboard.py

Writes deploy/helm/opencanvas/files/opencanvas-dashboard.json, which the Helm chart ships as a
ConfigMap (grafana.dashboard.enabled) and deploy/monitoring/ mounts into Grafana. Every query
uses only series the server exports on /metrics (docs/13 "Dashboards and alerts").
"""
import json
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "helm", "opencanvas", "files",
                   "opencanvas-dashboard.json")

S = 'job=~"$job",namespace=~"$namespace",instance=~"$instance"'
RI = "$__rate_interval"

panels = []
_id = [0]
_y = [0]


def nid():
    _id[0] += 1
    return _id[0]


def row(title, collapsed=False, children=None):
    p = {"type": "row", "title": title, "id": nid(), "collapsed": collapsed,
         "gridPos": {"h": 1, "w": 24, "x": 0, "y": _y[0]}, "panels": []}
    _y[0] += 1
    panels.append(p)
    return p


class Grid:
    """Lays panels left to right, wrapping at 24 columns."""

    def __init__(self):
        self.x = 0
        self.h = 0

    def place(self, w, h):
        if self.x + w > 24:
            _y[0] += self.h
            self.x, self.h = 0, 0
        pos = {"h": h, "w": w, "x": self.x, "y": _y[0]}
        self.x += w
        self.h = max(self.h, h)
        return pos

    def end(self):
        _y[0] += self.h
        self.x, self.h = 0, 0


def target(expr, legend="", ref="A", instant=False):
    t = {"datasource": {"type": "prometheus", "uid": "${datasource}"}, "expr": expr,
         "legendFormat": legend, "refId": ref, "range": not instant}
    if instant:
        t["instant"] = True
    return t


def ts(g, title, exprs, unit="short", desc="", w=8, h=8, stack=False, min0=True):
    p = {"type": "timeseries", "title": title, "id": nid(), "description": desc,
         "datasource": {"type": "prometheus", "uid": "${datasource}"},
         "gridPos": g.place(w, h),
         "targets": [target(e, l, chr(65 + i)) for i, (e, l) in enumerate(exprs)],
         "fieldConfig": {"defaults": {"unit": unit, "custom": {
             "drawStyle": "line", "lineWidth": 1, "fillOpacity": 10, "showPoints": "never",
             "spanNulls": True, "stacking": {"mode": "normal" if stack else "none"}}},
             "overrides": []},
         "options": {"legend": {"displayMode": "list", "placement": "bottom", "showLegend": True},
                     "tooltip": {"mode": "multi", "sort": "desc"}}}
    if min0:
        p["fieldConfig"]["defaults"]["min"] = 0
    panels.append(p)
    return p


def stat(g, title, expr, unit="short", desc="", w=4, h=4, thresholds=None, mappings=None,
         legend=""):
    steps = thresholds or [{"color": "green", "value": None}]
    p = {"type": "stat", "title": title, "id": nid(), "description": desc,
         "datasource": {"type": "prometheus", "uid": "${datasource}"},
         "gridPos": g.place(w, h),
         "targets": [target(expr, legend, "A", instant=True)],
         "fieldConfig": {"defaults": {"unit": unit, "mappings": mappings or [],
                                      "thresholds": {"mode": "absolute", "steps": steps}},
                         "overrides": []},
         "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                     "colorMode": "value", "graphMode": "none", "textMode": "auto",
                     "justifyMode": "auto", "orientation": "auto"}}
    panels.append(p)
    return p


def text(g, title, md, w=24, h=3):
    p = {"type": "text", "title": title, "id": nid(), "gridPos": g.place(w, h),
         "options": {"mode": "markdown", "content": md}}
    panels.append(p)
    return p


def red_at(v):
    return [{"color": "green", "value": None}, {"color": "red", "value": v}]


def q(h, metric, by=None, extra=""):
    """histogram_quantile over a bucket rate, summed by `le` (+ `by`)."""
    lbl = "le" + ("," + by if by else "")
    sel = S + ("," + extra if extra else "")
    return f"histogram_quantile({h}, sum by ({lbl}) (rate({metric}_bucket{{{sel}}}[{RI}])))"


# ---------------------------------------------------------------- traffic and health
row("Traffic and health")
g = Grid()
stat(g, "Ready nodes", f"sum(oc_ready{{{S}}})",
     desc="Nodes whose /readyz answers 200 (oc_ready): database reachable and not draining.",
     thresholds=[{"color": "red", "value": None}, {"color": "green", "value": 1}])
stat(g, "Scrape up", f"sum(up{{{S}}})",
     desc="Targets Prometheus scraped successfully (up). Below the node count = a node is down.",
     thresholds=[{"color": "red", "value": None}, {"color": "green", "value": 1}])
stat(g, "Draining", f"sum(oc_draining{{{S}}})",
     desc="Nodes draining after SIGTERM (oc_draining). Non-zero during deploys only.",
     thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 1}])
stat(g, "Restarts (1 h)", f"sum(changes(process_start_time_seconds{{{S}}}[1h]))",
     desc="Process restarts in the last hour (changes of process_start_time_seconds).",
     thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 1},
                 {"color": "red", "value": 3}])
stat(g, "Uptime (youngest)", f"time() - max(process_start_time_seconds{{{S}}})", unit="s",
     desc="Seconds since the most recent process start.")
stat(g, "HTTP 5xx ratio", f"sum(rate(oc_http_responses_total{{{S},code=\"5xx\"}}[5m])) / "
     f"clamp_min(sum(rate(oc_http_responses_total{{{S}}}[5m])), 1e-9)", unit="percentunit",
     desc="Share of HTTP responses with a 5xx status over 5 min (oc_http_responses_total). "
          "501 from /v1/export/pdf without Gotenberg counts here.",
     thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 0.01},
                 {"color": "red", "value": 0.05}])
g.end()
ts(g, "HTTP responses / s by status class",
   [(f"sum by (code) (rate(oc_http_responses_total{{{S}}}[{RI}]))", "{{code}}")],
   unit="reqps", stack=True, w=12,
   desc="oc_http_responses_total{code}. WebSocket upgrades count as 1xx (101).")
ts(g, "Ready / draining per node",
   [(f"oc_ready{{{S}}}", "ready {{instance}}"), (f"oc_draining{{{S}}}", "draining {{instance}}")],
   w=12, desc="oc_ready and oc_draining per instance.")
g.end()

# ---------------------------------------------------------------- collaboration
row("Collaboration")
g = Grid()
stat(g, "Open rooms", f"sum(oc_rooms_active{{{S}}})", desc="oc_rooms_active, all nodes.")
stat(g, "Connections", f"sum(oc_connections_active{{{S}}})",
     desc="Open WebSocket connections (oc_connections_active), all nodes.")
stat(g, "Launches / min", f"sum(rate(oc_launches_total{{{S}}}[5m])) * 60",
     desc="Sessions started per minute (oc_launches_total).")
stat(g, "Edits / s", f"sum(rate(oc_updates_total{{{S}}}[5m]))", unit="ops",
     desc="Accepted document updates per second (oc_updates_total).")
stat(g, "Edit latency floor p95", q(0.95, "oc_wal_append_seconds"), unit="s",
     desc="p95 of one WAL append (oc_wal_append_seconds). Every accepted edit waits for it "
          "before fan-out, so it is the floor of sync latency. Alert above 50 ms.",
     thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 0.025},
                 {"color": "red", "value": 0.05}])
stat(g, "Rejected edits / s", f"sum(rate(oc_updates_rejected_total{{{S}}}[5m]))", unit="ops",
     desc="Updates refused by the server (read-only role, malformed): oc_updates_rejected_total.",
     thresholds=red_at(0.1))
g.end()
ts(g, "Rooms and connections",
   [(f"sum by (instance) (oc_rooms_active{{{S}}})", "rooms {{instance}}"),
    (f"sum by (instance) (oc_connections_active{{{S}}})", "connections {{instance}}")], w=8)
ts(g, "Edits / s",
   [(f"sum(rate(oc_updates_total{{{S}}}[{RI}]))", "accepted"),
    (f"sum(rate(oc_updates_rejected_total{{{S}}}[{RI}]))", "rejected")], unit="ops", w=8)
ts(g, "Sync latency floor (WAL append) p50 / p95 / p99",
   [(q(0.5, "oc_wal_append_seconds"), "p50"), (q(0.95, "oc_wal_append_seconds"), "p95"),
    (q(0.99, "oc_wal_append_seconds"), "p99")], unit="s", w=8,
   desc="oc_wal_append_seconds. There is no end-to-end edit latency histogram (see gaps).")
ts(g, "Launches / s",
   [(f"sum(rate(oc_launches_total{{{S}}}[{RI}]))", "started"),
    (f"sum(rate(oc_launches_rejected_total{{{S}}}[{RI}]))", "rejected")], unit="ops", w=12)
ts(g, "Presence fan-out / s",
   [(f"sum(rate(oc_awareness_broadcasts_total{{{S}}}[{RI}]))", "broadcast"),
    (f"sum(rate(oc_awareness_coalesced_total{{{S}}}[{RI}]))", "coalesced (inbox full)")],
   unit="ops", w=12,
   desc="Awareness frames fanned out, and those parked because a room inbox was full.")
g.end()

# ---------------------------------------------------------------- persistence
row("Persistence")
g = Grid()
stat(g, "Saves / min", f"sum(rate(oc_saves_total{{{S}}}[5m])) * 60",
     desc="Commits the host acknowledged (oc_saves_total).")
stat(g, "Save errors / min", f"sum(rate(oc_save_errors_total{{{S}}}[5m])) * 60",
     desc="Failed saves, each retried with backoff (oc_save_errors_total).",
     thresholds=red_at(0.01))
stat(g, "Conflicts (1 h)", f"sum(increase(oc_save_conflicts_total{{{S}}}[1h]))",
     desc="Host answered 409/412; the conflict policy (copy or reload) ran "
          "(oc_save_conflicts_total). With on_conflict=copy each is a conflict copy.",
     thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 1}])
stat(g, "Commit outbox", f"max(oc_commit_outbox_pending{{{S}}})",
     desc="Commits waiting for the host (oc_commit_outbox_pending). Whole store: every node of "
          "a cluster reports the same value, so this is max, not sum.",
     thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 1},
                 {"color": "red", "value": 20}])
stat(g, "Mean WAL batch", f"sum(rate(oc_wal_rows_total{{{S}}}[5m])) / "
     f"clamp_min(sum(rate(oc_wal_batches_total{{{S}}}[5m])), 1e-9)",
     desc="Updates per WAL batch (oc_wal_rows_total / oc_wal_batches_total).")
stat(g, "Schema warnings (1 h)", f"sum(increase(oc_schema_warnings_total{{{S}}}[1h]))",
     desc="Unknown blocks/attrs kept on read or write (oc_schema_warnings_total).")
g.end()
ts(g, "Saves / s",
   [(f"sum(rate(oc_saves_total{{{S}}}[{RI}]))", "saved"),
    (f"sum(rate(oc_save_errors_total{{{S}}}[{RI}]))", "failed (retried)"),
    (f"sum(rate(oc_save_conflicts_total{{{S}}}[{RI}]))", "conflict")], unit="ops", w=8)
ts(g, "Commit outbox depth",
   [(f"max(oc_commit_outbox_pending{{{S}}})", "pending")], w=8,
   desc="Should drain to 0. Growing = the host is not accepting saves.")
ts(g, "WAL writes / s",
   [(f"sum(rate(oc_wal_batches_total{{{S}}}[{RI}]))", "batches"),
    (f"sum(rate(oc_wal_rows_total{{{S}}}[{RI}]))", "rows")], unit="ops", w=8)
g.end()

# ---------------------------------------------------------------- host callbacks
row("Host callbacks")
g = Grid()
HS = 'host=~"$host"'
ts(g, "Host call p95 by host and operation",
   [(q(0.95, "oc_host_callback_seconds", "host,op", HS), "{{host}} {{op}}")], unit="s", w=8,
   desc="oc_host_callback_seconds{host,op}: load, save, copy, access, members, notify.")
ts(g, "Host calls / s by result",
   [(f"sum by (host, result) (rate(oc_host_callbacks_total{{{S},{HS}}}[{RI}]))",
     "{{host}} {{result}}")], unit="ops", w=8, stack=True,
   desc="oc_host_callbacks_total{host,op,result}; result is ok, conflict, 4xx, 5xx, "
        "unreachable or error.")
ts(g, "Host error ratio by host",
   # `or … * 0`: hosts without errors show 0 instead of no line.
   [(f"(sum by (host) (rate(oc_host_callbacks_total{{{S},{HS},result=~\"5xx|unreachable|error\"}}[5m]))"
     f" or sum by (host) (rate(oc_host_callbacks_total{{{S},{HS}}}[5m])) * 0)"
     f" / sum by (host) (rate(oc_host_callbacks_total{{{S},{HS}}}[5m]))", "{{host}}")],
   unit="percentunit", w=8, desc="5xx, unreachable and error over all calls, 5 min.")
g.end()

# ---------------------------------------------------------------- webhooks (WH-01)
row("Webhooks")
g = Grid()
ts(g, "Webhook deliveries / s by result",
   [(f"sum by (host, result) (rate(oc_webhook_deliveries_total{{{S},{HS}}}[{RI}]))",
     "{{host}} {{result}}")], unit="ops", w=8, stack=True,
   desc="oc_webhook_deliveries_total{host,result}; result is ok, retry, rejected (3xx/4xx), "
        "gave_up (out of attempts) or refused (URL off the callback origin).")
ts(g, "Webhook attempt p95 by host",
   [(q(0.95, "oc_webhook_delivery_seconds", "host", HS), "{{host}}")], unit="s", w=8,
   desc="oc_webhook_delivery_seconds{host}: time of one POST to the webhook URL (10 s timeout).")
ts(g, "Webhooks dropped / s by host",
   [(f"sum by (host) (rate(oc_webhook_deliveries_total{{{S},{HS},result=~\"gave_up|rejected|refused\"}}[{RI}]))",
     "{{host}}")], unit="ops", w=8,
   desc="Events that will not be delivered: given up, refused by the receiver, or not allowed.")
g.end()

# ---------------------------------------------------------------- exports
row("Exports")
g = Grid()
ts(g, "Exports / s by format and result",
   [(f"sum by (format, result) (rate(oc_exports_total{{{S}}}[{RI}]))", "{{format}} {{result}}")],
   unit="ops", w=8, stack=True, desc="oc_exports_total{format,result}.")
ts(g, "Export p95 by format",
   [(q(0.95, "oc_export_seconds", "format"), "{{format}}")], unit="s", w=8,
   desc="oc_export_seconds{format}. PDF includes the Gotenberg round trip.")
stat(g, "PDF errors (1 h)",
     f"sum(increase(oc_exports_total{{{S},format=\"pdf\",result=\"error\"}}[1h])) or vector(0)",
     desc="PDF exports that failed: Gotenberg down or erroring, or no OC_PDF_RENDERER (501).",
     w=4, h=8, thresholds=red_at(1))
stat(g, "DOCX errors (1 h)",
     f"sum(increase(oc_exports_total{{{S},format=\"docx\",result=\"error\"}}[1h])) or vector(0)",
     w=4, h=8, thresholds=red_at(1))
g.end()

# ---------------------------------------------------------------- process
row("Process")
g = Grid()
ts(g, "Resident memory", [(f"process_resident_memory_bytes{{{S}}}", "{{instance}}")],
   unit="bytes", w=6, desc="process_resident_memory_bytes (Linux /proc). Compare with the "
                           "container limit (chart default 1 GiB).")
ts(g, "CPU", [(f"rate(process_cpu_seconds_total{{{S}}}[{RI}])", "{{instance}}")],
   unit="short", w=6, desc="Cores used (rate of process_cpu_seconds_total).")
ts(g, "File descriptors",
   [(f"process_open_fds{{{S}}}", "open {{instance}}"),
    (f"process_max_fds{{{S}}}", "limit {{instance}}")], w=6,
   desc="Each WebSocket holds one; raise nofile above the connection count.")
ts(g, "Threads", [(f"process_threads{{{S}}}", "{{instance}}")], w=6)
g.end()

# ---------------------------------------------------------------- security
row("Security signals")
g = Grid()
ts(g, "Rejected launches by code",
   [(f"sum by (code) (rate(oc_launches_rejected_total{{{S}}}[{RI}]))", "{{code}}")],
   unit="ops", w=12, stack=True,
   desc="oc_launches_rejected_total{code}: bad signature, expired, replayed, unknown host…")
ts(g, "Refused edits and host 4xx",
   [(f"sum(rate(oc_updates_rejected_total{{{S}}}[{RI}]))", "edits refused"),
    (f"sum by (op) (rate(oc_host_callbacks_total{{{S},result=\"4xx\"}}[{RI}]))", "host 4xx {{op}}")],
   unit="ops", w=12,
   desc="Edits the server refused (role enforcement) and host calls answered 4xx (expired "
        "callback token, revoked access).")
g.end()

# ---------------------------------------------------------------- cluster
row("Cluster and Redis")
g = Grid()
text(g, "Cluster and Redis",
     "OpenCanvas exports no cluster or Redis series yet (relay frames, lease ownership, Redis "
     "latency are gaps in docs/13). In cluster mode the panels above sum over nodes; "
     "`oc_commit_outbox_pending` is store-wide (max). Scrape Redis with "
     "[redis_exporter](https://github.com/oliver006/redis_exporter) and MariaDB with "
     "mysqld_exporter.", h=3)
g.end()

# ---------------------------------------------------------------- AI (collapsed)
ai = row("AI (off unless OC_AI_CONFIG enables it)", collapsed=True)
before = len(panels)
g = Grid()
ts(g, "AI model calls / s by outcome",
   [(f"sum by (outcome) (rate(oc_ai_requests_total{{{S}}}[{RI}]))", "{{outcome}}")],
   unit="ops", w=8)
ts(g, "AI tokens / s", [(f"sum by (direction) (rate(oc_ai_tokens_total{{{S}}}[{RI}]))",
                          "{{direction}}")], w=8)
ts(g, "Agent run p95", [(q(0.95, "oc_ai_run_seconds"), "p95")], unit="s", w=8)
g.end()
ai["panels"] = panels[before:]
del panels[before:]

dashboard = {
    "title": "OpenCanvas",
    "uid": "opencanvas-ops",
    "description": "OpenCanvas operations (OPS-01): traffic, collaboration, persistence, host "
                   "callbacks, exports, process, security. Source: deploy/monitoring/build-dashboard.py.",
    "tags": ["opencanvas"],
    "editable": True,
    "graphTooltip": 1,
    "schemaVersion": 39,
    "version": 1,
    "time": {"from": "now-30m", "to": "now"},
    "refresh": "30s",
    "timezone": "",
    "annotations": {"list": []},
    "links": [],
    "templating": {"list": [
        {"name": "datasource", "label": "Data source", "type": "datasource", "query": "prometheus",
         "current": {}, "hide": 0, "refresh": 1, "regex": "", "options": []},
        {"name": "job", "label": "Job", "type": "query",
         "datasource": {"type": "prometheus", "uid": "${datasource}"},
         "definition": "label_values(oc_rooms_active, job)",
         "query": {"query": "label_values(oc_rooms_active, job)", "refId": "job"},
         "includeAll": True, "multi": True, "allValue": ".*", "refresh": 2, "sort": 1,
         "current": {"selected": True, "text": "All", "value": "$__all"}},
        {"name": "namespace", "label": "Namespace", "type": "query",
         "datasource": {"type": "prometheus", "uid": "${datasource}"},
         "definition": 'label_values(oc_rooms_active{job=~"$job"}, namespace)',
         "query": {"query": 'label_values(oc_rooms_active{job=~"$job"}, namespace)',
                   "refId": "namespace"},
         "includeAll": True, "multi": True, "allValue": ".*", "refresh": 2, "sort": 1,
         "current": {"selected": True, "text": "All", "value": "$__all"}},
        {"name": "instance", "label": "Instance", "type": "query",
         "datasource": {"type": "prometheus", "uid": "${datasource}"},
         "definition": 'label_values(oc_rooms_active{job=~"$job",namespace=~"$namespace"}, instance)',
         "query": {"query": 'label_values(oc_rooms_active{job=~"$job",namespace=~"$namespace"}, instance)',
                   "refId": "instance"},
         "includeAll": True, "multi": True, "allValue": ".*", "refresh": 2, "sort": 1,
         "current": {"selected": True, "text": "All", "value": "$__all"}},
        {"name": "host", "label": "Host id", "type": "query",
         "datasource": {"type": "prometheus", "uid": "${datasource}"},
         "definition": 'label_values(oc_host_callbacks_total{job=~"$job"}, host)',
         "query": {"query": 'label_values(oc_host_callbacks_total{job=~"$job"}, host)',
                   "refId": "host"},
         "includeAll": True, "multi": True, "allValue": ".*", "refresh": 2, "sort": 1,
         "current": {"selected": True, "text": "All", "value": "$__all"}},
    ]},
    "panels": panels,
}

with open(OUT, "w") as f:
    json.dump(dashboard, f, indent=2)
    f.write("\n")
n = sum(1 for p in panels if p["type"] != "row") + len(ai["panels"])
print(f"wrote {os.path.normpath(OUT)}: {n} panels")
