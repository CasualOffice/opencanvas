// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

package canvas

import "strings"

// MeetingNotesMarkdown is the first-load content of a meeting-notes canvas. OpenCanvas has no
// per-launch template for storage = "host" hosts, so the plugin seeds the canvas with Markdown
// (docs/05 §5: a load may answer Markdown) until the server offers one (DESIGN.md §8).
func MeetingNotesMarkdown(title string) string {
	title = strings.NewReplacer("\n", " ", "\r", " ").Replace(title)
	return "# " + title + "\n\n" +
		"## Agenda\n\n- \n\n" +
		"## Notes\n\n- \n\n" +
		"## Decisions\n\n- \n\n" +
		"## Action items\n\n- [ ] \n"
}
