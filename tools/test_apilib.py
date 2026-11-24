# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice

"""Tests of the OpenAPI reader and completeness check (tools/apilib.py, tools/check-openapi.py)."""

import importlib.util
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import apilib  # noqa: E402

_spec = importlib.util.spec_from_file_location("check_openapi", os.path.join(os.path.dirname(os.path.abspath(__file__)), "check-openapi.py"))
check_openapi = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_openapi)

SPEC = {
    "openapi": "3.1.0",
    "x-opencanvas-error-codes": [{"code": "BLOCK_NOT_FOUND", "status": [404], "detail": "no block", "description": "No block."}],
    "components": {"schemas": {
        "Problem": {"type": "object", "required": ["type", "title", "status", "code"], "properties": {
            "type": {"type": "string"}, "title": {"type": "string"}, "status": {"type": "integer"}, "code": {"type": "string"}}},
        "Block": {"type": "object", "required": ["blockId", "rev"], "properties": {
            "blockId": {"type": ["string", "null"]}, "rev": {"type": "string"}, "kind": {"type": "string", "enum": ["a", "b"]}}}}},
    "paths": {"/api/v1/files/{fileId}/blocks/{blockId}": {"get": {
        "operationId": "getBlock", "summary": "Read one block", "description": "One block.",
        "parameters": [{"name": "fileId", "in": "path", "required": True, "schema": {"type": "string"}, "example": "doc_1"},
                       {"name": "blockId", "in": "path", "required": True, "schema": {"type": "string"}, "example": "b_1"}],
        "responses": {"200": {"description": "OK", "content": {"application/json": {
            "schema": {"$ref": "#/components/schemas/Block"}, "example": {"blockId": "b_1", "rev": "r1"}}}},
            "404": {"description": "BLOCK_NOT_FOUND"}},
        "x-opencanvas-errors": ["BLOCK_NOT_FOUND"]}}},
}


def gaps(spec):
    return [e for e in check_openapi.check(spec, json.dumps(spec, indent=2, ensure_ascii=False) + "\n")
            if not e.startswith(("the server can answer", "x-opencanvas-error-codes documents"))]


class Validate(unittest.TestCase):
    def test_types_required_enum_and_refs(self):
        block = {"$ref": "#/components/schemas/Block"}
        self.assertEqual(apilib.validate({"blockId": None, "rev": "r"}, block, SPEC), [])
        self.assertTrue(apilib.validate({"blockId": 1, "rev": "r"}, block, SPEC))
        self.assertTrue(apilib.validate({"blockId": "b"}, block, SPEC))
        self.assertTrue(apilib.validate({"blockId": "b", "rev": "r", "kind": "c"}, block, SPEC))

    def test_unknown_keywords_are_reported(self):
        self.assertTrue(apilib.validate(1, {"type": "integer", "multipleOf": 2}, SPEC))


class Completeness(unittest.TestCase):
    def test_a_complete_operation_passes(self):
        self.assertEqual(gaps(SPEC), [])

    def test_each_gap_is_named(self):
        spec = json.loads(json.dumps(SPEC))
        op = spec["paths"]["/api/v1/files/{fileId}/blocks/{blockId}"]["get"]
        del op["description"]
        del op["parameters"][1]["example"]
        op["responses"]["200"]["content"]["application/json"]["example"] = {"rev": "r1"}
        op["x-opencanvas-errors"] = ["BLOCK_NOT_FOUND", "NOPE"]
        del op["responses"]["404"]
        found = "\n".join(gaps(spec))
        for want in ("getBlock: no description", "parameter blockId has no example", "missing required 'blockId'",
                     "error NOPE is not in", "lists BLOCK_NOT_FOUND (404) without a response"):
            self.assertIn(want, found)

    def test_the_repository_document_is_complete(self):
        raw = apilib.SPEC_PATH.read_text(encoding="utf8")
        self.assertEqual(check_openapi.check(json.loads(raw), raw), [])


if __name__ == "__main__":
    unittest.main()
