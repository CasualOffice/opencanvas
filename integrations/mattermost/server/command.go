// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

package main

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/casualoffice/opencanvas/integrations/mattermost/server/canvas"
	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
)

const trigger = "canvas"

// command is the /canvas registration with the approved autocomplete (MM S5a).
func command() *model.Command {
	ac := model.NewAutocompleteData(trigger, "[new|notes|list|help]", "Create a collaborative canvas in this channel")
	n := model.NewAutocompleteData("new", "[title]", "Create a canvas in this channel")
	n.AddTextArgument("Title (optional)", "[title]", "")
	m := model.NewAutocompleteData("notes", "[title]", "Create meeting notes: agenda, notes, decisions, actions")
	m.AddTextArgument("Title (optional)", "[title]", "")
	ac.AddCommand(n)
	ac.AddCommand(m)
	ac.AddCommand(model.NewAutocompleteData("list", "", "Show this channel's canvases"))
	ac.AddCommand(model.NewAutocompleteData("help", "", "How to use canvases"))
	return &model.Command{
		Trigger:          trigger,
		DisplayName:      "OpenCanvas",
		Description:      "Create a collaborative canvas in this channel",
		AutoComplete:     true,
		AutoCompleteDesc: "Create a canvas: /canvas new [title], /canvas notes [title]",
		AutoCompleteHint: "[new|notes|list|help]",
		AutocompleteData: ac,
	}
}

// The approved replies (MM S5b, S5c). Ephemeral posts: only the person who typed sees them.
const helpText = "#### Canvases in Mattermost channels\n" +
	"`/canvas new [title]` creates a canvas in this channel and opens it. " +
	"`/canvas notes [title]` creates meeting notes with Agenda, Notes, Decisions and Action items. " +
	"`/canvas list` shows this channel's canvases.\n\n" +
	"Everyone in the channel can open and edit its canvases. They're saved on your Mattermost server. " +
	"On the phone apps a canvas shows as a message; open it on the web or desktop."

const (
	replyNotAllowed = "You can't create a canvas in this channel. Ask a channel member to create one and share it here."
	replyFailed     = "Couldn't create the canvas. Try again in a moment."
	replyNoList     = "You can't see this channel's canvases."
	replyListEmpty  = "No canvases in this channel yet. Create one with `/canvas new [title]`."
)

func replyNotConfigured(admin bool) string {
	s := "Canvases aren't set up yet. Ask your Mattermost admin to finish the OpenCanvas plugin settings."
	if admin {
		s += "\nOpen **System Console → Plugins → OpenCanvas**."
	}
	return s
}

func ephemeral(text string) *model.CommandResponse {
	return &model.CommandResponse{ResponseType: model.CommandResponseTypeEphemeral, Text: text}
}

// ExecuteCommand handles /canvas. The card is posted by the user who ran the command. In the
// web and desktop app the webapp opens the channel canvases panel for `/canvas list` before
// the command reaches the server; this text answer is for the phone apps.
func (p *Plugin) ExecuteCommand(_ *plugin.Context, args *model.CommandArgs) (*model.CommandResponse, *model.AppError) {
	sub, title := parseCommand(args.Command)
	svc := p.service()
	if svc == nil {
		return ephemeral(replyNotConfigured(p.API.HasPermissionTo(args.UserId, model.PermissionManageSystem))), nil
	}
	template := ""
	switch sub {
	case "new", "":
	case "notes", "meeting":
		template = "meeting"
	case "list":
		return ephemeral(p.listReply(svc, args)), nil
	default:
		return ephemeral(helpText), nil
	}
	rec, err := svc.CreateForUser(args.UserId, args.ChannelId, title, template)
	switch {
	case errors.Is(err, canvas.ErrNoAccess):
		return ephemeral(replyNotAllowed), nil
	case err != nil:
		p.API.LogError("OpenCanvas: create failed", "err", err.Error())
		return ephemeral(replyFailed), nil
	}
	// The webapp opens the new canvas in the panel, as after the create dialog (S2f).
	p.API.PublishWebSocketEvent("canvas_created", map[string]any{"fileId": rec.ID}, &model.WebsocketBroadcast{UserId: args.UserId})
	return &model.CommandResponse{}, nil
}

func (p *Plugin) listReply(svc *canvas.Service, args *model.CommandArgs) string {
	recs, err := svc.ChannelList(args.UserId, args.ChannelId)
	if errors.Is(err, canvas.ErrNoAccess) {
		return replyNoList
	} else if err != nil {
		return "Couldn't load canvases. Try again in a moment."
	}
	if len(recs) == 0 {
		return replyListEmpty
	}
	var b strings.Builder
	b.WriteString("#### Canvases in this channel\n")
	for _, r := range recs {
		kind := "Canvas"
		if r.Template == "meeting" {
			kind = "Meeting notes"
		}
		link := r.Title
		if r.PostID != "" {
			link = fmt.Sprintf("[%s](%s)", r.Title, svc.B.PostURL(r.PostID))
		}
		fmt.Fprintf(&b, "* %s · %s · edited %s\n", link, kind, time.UnixMilli(r.UpdatedAt).UTC().Format("2006-01-02"))
	}
	return b.String()
}

// parseCommand splits "/canvas new Sprint 42" into ("new", "Sprint 42").
func parseCommand(cmd string) (string, string) {
	f := strings.Fields(cmd)
	if len(f) < 2 {
		return "", ""
	}
	return strings.ToLower(f[1]), strings.Join(f[2:], " ")
}
