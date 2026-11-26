// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

package main

import "testing"

func TestParseCommand(t *testing.T) {
	cases := map[string][2]string{
		"/canvas":                     {"", ""},
		"/canvas new":                 {"new", ""},
		"/canvas new  Sprint 42 plan": {"new", "Sprint 42 plan"},
		"/canvas NOTES Weekly sync":   {"notes", "Weekly sync"},
	}
	for in, want := range cases {
		if sub, title := parseCommand(in); sub != want[0] || title != want[1] {
			t.Errorf("%q: %q %q", in, sub, title)
		}
	}
}

func TestCommandRegistration(t *testing.T) {
	c := command()
	if c.Trigger != "canvas" || !c.AutoComplete || c.AutocompleteData == nil || len(c.AutocompleteData.SubCommands) != 4 {
		t.Fatalf("%+v", c)
	}
	if err := c.AutocompleteData.IsValid(); err != nil {
		t.Fatal(err)
	}
}

// MM-02 S5: the approved replies, word for word.
func TestCommandReplies(t *testing.T) {
	want := map[string]string{
		"help": "#### Canvases in Mattermost channels\n" +
			"`/canvas new [title]` creates a canvas in this channel and opens it. " +
			"`/canvas notes [title]` creates meeting notes with Agenda, Notes, Decisions and Action items. " +
			"`/canvas list` shows this channel's canvases.\n\n" +
			"Everyone in the channel can open and edit its canvases. They're saved on your Mattermost server. " +
			"On the phone apps a canvas shows as a message; open it on the web or desktop.",
		"notConfigured":      "Canvases aren't set up yet. Ask your Mattermost admin to finish the OpenCanvas plugin settings.",
		"notConfiguredAdmin": "Canvases aren't set up yet. Ask your Mattermost admin to finish the OpenCanvas plugin settings.\nOpen **System Console → Plugins → OpenCanvas**.",
		"notAllowed":         "You can't create a canvas in this channel. Ask a channel member to create one and share it here.",
		"failed":             "Couldn't create the canvas. Try again in a moment.",
	}
	got := map[string]string{
		"help": helpText, "notConfigured": replyNotConfigured(false), "notConfiguredAdmin": replyNotConfigured(true),
		"notAllowed": replyNotAllowed, "failed": replyFailed,
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s:\n got %q\nwant %q", k, got[k], v)
		}
	}
}

// LEGAL-01: "Mattermost" is used only as an adjective in what people read.
func TestCardMessageUsesMattermostAsAnAdjective(t *testing.T) {
	want := "Canvas: Sprint 42 (open it in the Mattermost web or desktop app)"
	if got := cardMessage("Sprint 42"); got != want {
		t.Fatalf("got %q\nwant %q", got, want)
	}
}
