#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

"""Completeness check of the OpenAPI document (API-DOCS-01), the source of the website's API
reference. Fails, naming each gap, unless:

- every operation has a summary, a description and `x-opencanvas-errors` (the codes it can
  answer, each in the `x-opencanvas-error-codes` catalogue, with a declared response for its
  status);
- every operation has an example request (an example for each path and required parameter,
  and for its body when it takes one) and an example answer (its success response);
- every example matches its schema (tools/apilib.py's validator);
- every error code the server's API code can produce is in the catalogue, and the catalogue
  names no code the server never produces;
- the document is formatted as the repository keeps it (two-space JSON, UTF-8).

    python3 tools/check-openapi.py

Standard library only. The contract test crates/oc-server/tests/api_v1.rs separately holds
the document and the router to each other.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import apilib  # noqa: E402

ROOT = apilib.ROOT
SRC = ROOT / "crates/oc-server/src"
# The code paths /api/v1 and the 0.1 routes run through.
SOURCES = ["routes/v1/*.rs", "routes/api.rs", "routes/import.rs", "routes/export.rs", "routes/mod.rs", "live/*.rs",
           "authz.rs", "ai/tools.rs", "ai/tools/*.rs"]
# Codes in those files that are not API error codes: editor-session errors and board image
# exports (editor routes), the room's own
# restore answers, CSV values, and the editor-only live block session routes (LIVE-01).
NOT_API = {"TICKET_INVALID", "TRUE", "VERSION_INVALID", "BOARD_NOT_FOUND", "LIVE_NOT_EMBEDDED",
           "LIVE_NO_ACCESS"}


def source_codes() -> set[str]:
    codes: set[str] = set()
    for pattern in SOURCES:
        for f in sorted(SRC.glob(pattern)):
            text = f.read_text(encoding="utf8")
            text = text.split("#[cfg(test)]")[0]  # unit tests quote codes they expect
            # A code: a quoted upper-case word that an error is built with, or that leads a
            # message ("SCOPE_REQUIRED: ...").
            codes |= set(re.findall(r'"([A-Z][A-Z0-9_]{2,})"', text))
            codes |= set(re.findall(r'"([A-Z][A-Z0-9_]{2,}): ', text))
    return codes - NOT_API


def check(spec: dict, raw: str) -> list[str]:
    errs: list[str] = []
    if raw != json.dumps(spec, indent=2, ensure_ascii=False) + "\n":
        errs.append("openapi.json is not formatted as json.dumps(indent=2, ensure_ascii=False) plus a newline")
    cat = apilib.catalogue(spec)
    for e in spec.get("x-opencanvas-error-codes", []):
        for k in ("code", "status", "detail", "description"):
            if k not in e:
                errs.append(f"error code {e.get('code')}: no {k}")
    for o in apilib.operations(spec):
        op, oid = o["op"], o["id"]
        for k in ("summary", "description"):
            if not (op.get(k) or "").strip():
                errs.append(f"{oid}: no {k}")
        for p in apilib.params(spec, op):
            if (p["in"] == "path" or p.get("required")) and "example" not in p:
                errs.append(f"{oid}: parameter {p['name']} has no example")
        _ct, media, _req = apilib.request_media(spec, op)
        if media is not None and not apilib.media_example(media)[0]:
            errs.append(f"{oid}: the request body has no example")
        code, res = apilib.success(spec, op)
        if code is None:
            errs.append(f"{oid}: no success response")
        else:
            for ct, m in (res.get("content") or {}).items():
                if not apilib.media_example(m)[0]:
                    errs.append(f"{oid}: response {code} ({ct}) has no example")
        if "x-opencanvas-errors" not in op:
            errs.append(f"{oid}: no x-opencanvas-errors")
            continue
        declared = {c for c in (op.get("responses") or {})}
        for c in op["x-opencanvas-errors"]:
            if c not in cat:
                errs.append(f"{oid}: error {c} is not in x-opencanvas-error-codes")
                continue
            if cat[c].get("kind") == "general":
                errs.append(f"{oid}: {c} is a router fallback; it is documented once, not per operation")
            statuses = [s for s in cat[c]["status"] if s != 500]
            if statuses and not any(str(s) in declared for s in statuses):
                errs.append(f"{oid}: lists {c} ({'/'.join(map(str, statuses))}) without a response for that status")
    errs += apilib.check_examples(spec)
    found = source_codes()
    for c in sorted(found - set(cat)):
        errs.append(f"the server can answer {c}, which x-opencanvas-error-codes does not document")
    for c in sorted(set(cat) - found):
        errs.append(f"x-opencanvas-error-codes documents {c}, which the server code never produces")
    return errs


def main() -> int:
    raw = apilib.SPEC_PATH.read_text(encoding="utf8")
    spec = json.loads(raw)
    errs = check(spec, raw)
    if errs:
        print(f"check-openapi: {len(errs)} gap(s) in crates/oc-server/api/openapi.json", file=sys.stderr)
        for e in errs:
            print(f"  {e}", file=sys.stderr)
        return 1
    n = len(apilib.operations(spec))
    print(f"check-openapi: {n} operations, each with a summary, a description, example request and answer, "
          f"and its errors; {len(apilib.catalogue(spec))} error codes match the server")
    return 0


if __name__ == "__main__":
    sys.exit(main())
