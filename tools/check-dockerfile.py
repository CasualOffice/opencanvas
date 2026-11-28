#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice
"""Fail when a web package's manifest is not copied in an image's dependency layer.

Each image installs dependencies from the copied manifests only, so a package missing here
builds locally but fails in the release image (v0.4.0 and v0.4.1: lucide-react in sheet).
Checked: the engine image (deploy/Dockerfile) and OpenCanvas Workspace
(deploy/workspace/Dockerfile), which builds the editor and the Workspace web apps and so
needs every workspace package the editor imports.
"""
import pathlib, sys
root = pathlib.Path(__file__).resolve().parent.parent
DOCKERFILES = ["deploy/Dockerfile", "deploy/workspace/Dockerfile"]
packages = [d.name for d in sorted((root / "web/packages").iterdir()) if (d / "package.json").exists()]
errors = []
for rel in DOCKERFILES:
    docker = (root / rel).read_text()
    missing = [p for p in packages if f"COPY web/packages/{p}/package.json" not in docker]
    if missing:
        errors.append(f"check-dockerfile: {rel} does not copy the manifest of: {', '.join(missing)}")
if errors:
    sys.exit("\n".join(errors))
