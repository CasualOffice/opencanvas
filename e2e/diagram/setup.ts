// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { execSync } from "node:child_process";
import path from "node:path";
import { ROOT } from "../env";

export default function setup() {
  if (process.env.E2E_SKIP_BUILD !== "1") execSync("pnpm --filter @opencanvas/editor build", { cwd: path.join(ROOT, "web"), stdio: "inherit" });
}
