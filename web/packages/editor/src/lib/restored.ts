// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

/**
 * VH-01d frame 6b: what everyone else sees when someone restores a version, from the
 * `restored` control (`name` is the restore version's name, "Restored from …").
 */
export function restoredText(c: { byName?: string; name?: string }): string {
  const who = (c.byName ?? "").split(/\s+/)[0] || "Someone";
  const from = (c.name ?? "").replace(/^Restored from /, "");
  const what = /^“.*”$/.test(from) ? `restored ${from}` : from ? `restored the version from ${from}` : "restored an earlier version";
  return `${who} ${what}. Earlier edits are in Version history.`;
}
