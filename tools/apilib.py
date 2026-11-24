# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

"""Reading the OpenAPI document (crates/oc-server/api/openapi.json) for the API reference
(tools/build-api.py) and its completeness check (tools/check-openapi.py): operations in
document order, `$ref` resolution, the examples an operation carries, the error catalogue,
and a validator for the JSON Schema subset the document uses. Standard library only.

The document carries two extensions besides `x-opencanvas-scope`:

- `x-opencanvas-error-codes` (top level): every machine `code` an error answer can carry,
  `{code, status: [..], detail, description, kind}`; `kind` is `common` (any /api/v1
  operation on a file can answer it), `general` (not tied to an operation: the router's
  fallbacks), `legacy` (the 0.1 routes only) or absent (operation-specific).
- `x-opencanvas-errors` (per operation): the codes that operation can answer.
"""

from __future__ import annotations

import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SPEC_PATH = ROOT / "crates/oc-server/api/openapi.json"
METHODS = ("get", "put", "post", "patch", "delete")

REASONS = {
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
    409: "Conflict", 410: "Gone", 412: "Precondition Failed", 413: "Payload Too Large",
    415: "Unsupported Media Type", 422: "Unprocessable Entity", 429: "Too Many Requests",
    500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable",
    200: "OK", 101: "Switching Protocols", 202: "Accepted",
}


def load(path: pathlib.Path = SPEC_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf8"))


def deref(spec: dict, node):
    """(node, name): follows `$ref` chains inside the document; name is the last ref's name."""
    name = None
    seen = 0
    while isinstance(node, dict) and "$ref" in node:
        ref = node["$ref"]
        if not ref.startswith("#/"):
            raise ValueError(f"external $ref {ref}")
        name = ref.rsplit("/", 1)[-1]
        cur = spec
        for part in ref[2:].split("/"):
            cur = cur[part.replace("~1", "/").replace("~0", "~")]
        node = cur
        seen += 1
        if seen > 20:
            raise ValueError(f"$ref loop at {ref}")
    return node, name


def operations(spec: dict) -> list[dict]:
    """Every operation in document order: {id, method, path, op, tag}."""
    out = []
    for path, item in spec["paths"].items():
        for method, op in item.items():
            if method not in METHODS:
                continue
            out.append({"id": op["operationId"], "method": method, "path": path, "op": op,
                        "tag": (op.get("tags") or ["other"])[0]})
    return out


def params(spec: dict, op: dict) -> list[dict]:
    return [deref(spec, p)[0] for p in op.get("parameters", [])]


def media_example(media: dict):
    """(True, value) for a media type object's `example` or first `examples` entry."""
    if "example" in media:
        return True, media["example"]
    for ex in (media.get("examples") or {}).values():
        if isinstance(ex, dict) and "value" in ex:
            return True, ex["value"]
    return False, None


def request_media(spec: dict, op: dict) -> tuple[str | None, dict | None, bool]:
    """(content type, media object, required) of the request body, or (None, None, False)."""
    rb = op.get("requestBody")
    if not rb:
        return None, None, False
    rb, _ = deref(spec, rb)
    for ctype, media in (rb.get("content") or {}).items():
        return ctype, media, bool(rb.get("required"))
    return None, None, False


def responses(spec: dict, op: dict) -> list[tuple[str, dict, str | None]]:
    """(status, response, component name) sorted by status."""
    out = []
    for code, r in (op.get("responses") or {}).items():
        res, name = deref(spec, r)
        out.append((code, res, name))
    out.sort(key=lambda x: (int(x[0]) if x[0].isdigit() else 999))
    return out


def success(spec: dict, op: dict):
    """The first 1xx/2xx response: (status, response) or (None, None)."""
    for code, res, _ in responses(spec, op):
        if code.startswith("2"):
            return code, res
    for code, res, _ in responses(spec, op):
        if code.startswith("1"):
            return code, res
    return None, None


def catalogue(spec: dict) -> dict[str, dict]:
    return {e["code"]: e for e in spec.get("x-opencanvas-error-codes", [])}


def type_uri(code: str) -> str:
    return "urn:opencanvas:problem:" + code.lower().replace("_", "-")


def problem_example(entry: dict, status: int | None = None) -> dict:
    """The RFC 9457 body the server answers for a catalogue entry."""
    s = status or entry["status"][0]
    body = {"type": type_uri(entry["code"]), "title": REASONS.get(s, "Error"), "status": s,
            "detail": entry["detail"], "code": entry["code"]}
    if "extra" in entry:
        body.update(entry["extra"])
    return body


def legacy_example(entry: dict) -> dict:
    return {"error": {"code": entry["code"], "message": entry["detail"]}}


def check_examples(spec: dict) -> list[str]:
    """Every example the reference shows, against its schema (also tools/check-openapi.py)."""
    errs = []
    for o in operations(spec):
        op = o["op"]
        for p in params(spec, op):
            if "example" in p:
                errs += [f"{o['id']} parameter {p['name']}: {e}" for e in validate(p["example"], p.get("schema") or {}, spec)]
        _ct, media, _r = request_media(spec, op)
        if media is not None:
            has, val = media_example(media)
            if has:
                errs += [f"{o['id']} request: {e}" for e in validate(val, media.get("schema") or {}, spec)]
        for code, res, _comp in responses(spec, op):
            for _ct2, m in (res.get("content") or {}).items():
                has, val = media_example(m)
                if has:
                    errs += [f"{o['id']} {code}: {e}" for e in validate(val, m.get("schema") or {}, spec)]
    problem = spec["components"]["schemas"]["Problem"]
    for e in spec.get("x-opencanvas-error-codes", []):
        if e["status"]:
            errs += [f"error {e['code']}: {x}" for x in validate(problem_example(e), problem, spec)]
    return errs


# ---- A validator for the schema subset the document uses ------------------------------

_TYPES = {
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
    "array": lambda v: isinstance(v, list),
    "object": lambda v: isinstance(v, dict),
}

KNOWN = {"type", "enum", "properties", "required", "items", "additionalProperties", "minItems", "maxItems",
         "minLength", "maxLength", "minimum", "maximum", "format", "description", "example", "examples",
         "$ref", "const", "pattern", "default", "title"}


def validate(value, schema, spec: dict, at: str = "$") -> list[str]:
    """Errors of `value` against `schema` (an empty list when valid). Keywords outside the
    subset are reported, so the document cannot use one this check silently ignores."""
    schema, _ = deref(spec, schema)
    if not isinstance(schema, dict):
        return [f"{at}: schema is not an object"]
    errs = [f"{at}: unsupported schema keyword {k!r}" for k in schema if k not in KNOWN and not k.startswith("x-")]
    types = schema.get("type")
    types = [types] if isinstance(types, str) else (types or [])
    if types and not any(_TYPES[t](value) for t in types):
        return errs + [f"{at}: {json.dumps(value)[:60]} is not {' or '.join(types)}"]
    if "enum" in schema and value not in schema["enum"]:
        errs.append(f"{at}: {json.dumps(value)[:60]} is not one of {schema['enum']}")
    if "const" in schema and value != schema["const"]:
        errs.append(f"{at}: must be {schema['const']!r}")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errs.append(f"{at}: shorter than {schema['minLength']}")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errs.append(f"{at}: longer than {schema['maxLength']}")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errs.append(f"{at}: does not match {schema['pattern']}")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errs.append(f"{at}: below {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errs.append(f"{at}: above {schema['maximum']}")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errs.append(f"{at}: fewer than {schema['minItems']} items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errs.append(f"{at}: more than {schema['maxItems']} items")
        if isinstance(schema.get("items"), dict):
            for i, v in enumerate(value):
                errs += validate(v, schema["items"], spec, f"{at}[{i}]")
    if isinstance(value, dict):
        props = schema.get("properties") or {}
        for r in schema.get("required") or []:
            if r not in value:
                errs.append(f"{at}: missing required {r!r}")
        for k, v in value.items():
            if k in props:
                errs += validate(v, props[k], spec, f"{at}.{k}")
            elif schema.get("additionalProperties") is False:
                errs.append(f"{at}: unexpected property {k!r}")
            elif isinstance(schema.get("additionalProperties"), dict):
                errs += validate(v, schema["additionalProperties"], spec, f"{at}.{k}")
    return errs


def synth(schema, spec: dict, depth: int = 0):
    """A value made from a schema, for a schema without an example: its own example, the
    first enum value, else a placeholder of its type with every required property."""
    schema, _ = deref(spec, schema)
    if not isinstance(schema, dict) or depth > 6:
        return None
    if "example" in schema:
        return schema["example"]
    if schema.get("examples"):
        return schema["examples"][0]
    if "enum" in schema:
        return schema["enum"][0]
    types = schema.get("type")
    types = [types] if isinstance(types, str) else [t for t in (types or []) if t != "null"]
    t = types[0] if types else ("object" if "properties" in schema else None)
    if t == "string":
        return "string"
    if t in ("integer", "number"):
        return schema.get("minimum", 0)
    if t == "boolean":
        return True
    if t == "array":
        item = synth(schema.get("items") or {}, spec, depth + 1)
        return [] if item is None else [item]
    if t == "object":
        props = schema.get("properties") or {}
        req = schema.get("required") or list(props)
        return {k: synth(props[k], spec, depth + 1) for k in req if k in props}
    return None
