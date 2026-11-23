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
	if c.Trigger != "canvas" || !c.AutoComplete || c.AutocompleteData == nil || len(c.AutocompleteData.SubCommands) != 3 {
		t.Fatalf("%+v", c)
	}
	if err := c.AutocompleteData.IsValid(); err != nil {
		t.Fatal(err)
	}
}
