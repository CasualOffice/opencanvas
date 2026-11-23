// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

package main

import (
	"errors"
	"strings"

	"github.com/casualoffice/opencanvas/integrations/mattermost/server/canvas"
	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
)

const trigger = "canvas"

func command() *model.Command {
	ac := model.NewAutocompleteData(trigger, "[new|notes|help]", "Create a collaborative canvas in this channel")
	n := model.NewAutocompleteData("new", "[title]", "Create a canvas and post it to this channel")
	n.AddTextArgument("Title (optional)", "[title]", "")
	m := model.NewAutocompleteData("notes", "[title]", "Create meeting notes (agenda, notes, decisions, action items)")
	m.AddTextArgument("Title (optional)", "[title]", "")
	ac.AddCommand(n)
	ac.AddCommand(m)
	ac.AddCommand(model.NewAutocompleteData("help", "", "Show help"))
	return &model.Command{
		Trigger:          trigger,
		DisplayName:      "OpenCanvas",
		Description:      "Create a collaborative canvas in this channel",
		AutoComplete:     true,
		AutoCompleteDesc: "Create a canvas: /canvas new [title], /canvas notes [title]",
		AutoCompleteHint: "[new|notes|help]",
		AutocompleteData: ac,
	}
}

const helpText = "* `/canvas new [title]`: create a canvas and post it to this channel\n" +
	"* `/canvas notes [title]`: create meeting notes\n" +
	"Everyone in the channel can open and edit it. It is saved in Mattermost."

func ephemeral(text string) *model.CommandResponse {
	return &model.CommandResponse{ResponseType: model.CommandResponseTypeEphemeral, Text: text}
}

// ExecuteCommand handles /canvas. The card is posted by the user who ran the command.
func (p *Plugin) ExecuteCommand(_ *plugin.Context, args *model.CommandArgs) (*model.CommandResponse, *model.AppError) {
	sub, title := parseCommand(args.Command)
	svc := p.service()
	if svc == nil {
		return ephemeral("OpenCanvas is not set up yet. Ask a system admin to configure the plugin."), nil
	}
	template := ""
	switch sub {
	case "new", "":
	case "notes", "meeting":
		template = "meeting"
	default:
		return ephemeral(helpText), nil
	}
	_, err := svc.CreateForUser(args.UserId, args.ChannelId, title, template)
	switch {
	case errors.Is(err, canvas.ErrNoAccess):
		return ephemeral("You can't create a canvas in this channel."), nil
	case err != nil:
		p.API.LogError("OpenCanvas: create failed", "err", err.Error())
		return ephemeral("The canvas could not be created. Try again."), nil
	}
	return &model.CommandResponse{}, nil
}

// parseCommand splits "/canvas new Sprint 42" into ("new", "Sprint 42").
func parseCommand(cmd string) (string, string) {
	f := strings.Fields(cmd)
	if len(f) < 2 {
		return "", ""
	}
	return strings.ToLower(f[1]), strings.Join(f[2:], " ")
}
