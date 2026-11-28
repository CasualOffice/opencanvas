#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice
"""Fail when a web package's manifest is not copied in the image's dependency layer.

The image installs dependencies from the copied manifests only, so a package missing here
builds locally but fails in the release image (v0.4.0 and v0.4.1: lucide-react in sheet).
"""
import pathlib, sys
root = pathlib.Path(__file__).resolve().parent.parent
docker = (root / "deploy/Dockerfile").read_text()
missing = [d.name for d in sorted((root / "web/packages").iterdir())
           if (d / "package.json").exists() and f"COPY web/packages/{d.name}/package.json" not in docker]
if missing:
    sys.exit(f"check-dockerfile: deploy/Dockerfile does not copy the manifest of: {', '.join(missing)}")
