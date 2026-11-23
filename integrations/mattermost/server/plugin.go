// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

package main

import (
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/casualoffice/opencanvas/integrations/mattermost/server/canvas"
	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
)

// PostType is the custom post type of a canvas card (webapp registerPostTypeComponent).
const PostType = "custom_opencanvas"

// Plugin is the Mattermost side of OpenCanvas: it is the OpenCanvas *host* (docs/05).
type Plugin struct {
	plugin.MattermostPlugin

	mu  sync.RWMutex
	svc *canvas.Service // nil until configured
}

type settings struct {
	OpenCanvasURL    string
	OpenCanvasAPIURL string
	HostID           string
	SharedSecret     string
	CallbackSecret   string
	APIKey           string
	GuestRole        string
	TokenTTLMinutes  int
}

// OnConfigurationChange validates the settings; a bad value disables the plugin's endpoints
// and is logged by setting name only (never its value).
func (p *Plugin) OnConfigurationChange() error {
	var s settings
	if err := p.API.LoadPluginConfiguration(&s); err != nil {
		return err
	}
	cfg, err := canvas.Config(s).Validate()
	p.mu.Lock()
	defer p.mu.Unlock()
	if err != nil {
		p.svc = nil
		p.API.LogWarn("OpenCanvas is not configured", "reason", err.Error())
		return nil
	}
	site := ""
	if c := p.API.GetConfig(); c != nil && c.ServiceSettings.SiteURL != nil {
		site = *c.ServiceSettings.SiteURL
	}
	p.svc = &canvas.Service{Cfg: cfg, B: &backend{api: p.API, siteURL: site}, SiteURL: site, OC: canvas.NewClient(cfg)}
	return nil
}

func (p *Plugin) service() *canvas.Service {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.svc
}

// OnActivate registers /canvas.
func (p *Plugin) OnActivate() error {
	return p.API.RegisterCommand(command())
}

// ServeHTTP: /oc/... OpenCanvas callbacks, /api/v1/... the webapp (see canvas.Service).
func (p *Plugin) ServeHTTP(_ *plugin.Context, w http.ResponseWriter, r *http.Request) {
	svc := p.service()
	if svc == nil {
		http.Error(w, `{"error":"NOT_CONFIGURED"}`, http.StatusServiceUnavailable)
		return
	}
	svc.ServeHTTP(w, r)
}

// UserHasLeftChannel ends the person's open sessions on the channel's canvases at once.
func (p *Plugin) UserHasLeftChannel(_ *plugin.Context, m *model.ChannelMember, _ *model.User) {
	if svc := p.service(); svc != nil && m != nil {
		go func() {
			if n := svc.UserLeftChannel(m.ChannelId, m.UserId); n > 0 {
				p.API.LogWarn("OpenCanvas: could not end access on some canvases; it ends when the session expires", "failed", n)
			}
			svc.ChannelMembershipChanged(m.ChannelId)
		}()
	}
}

// UserHasJoinedChannel refreshes the canvases' @mention lists.
func (p *Plugin) UserHasJoinedChannel(_ *plugin.Context, m *model.ChannelMember, _ *model.User) {
	if svc := p.service(); svc != nil && m != nil {
		go svc.ChannelMembershipChanged(m.ChannelId)
	}
}

// ---------------------------------------------------------------- backend adapter

type backend struct {
	api     plugin.API
	siteURL string
}

var _ canvas.Backend = (*backend)(nil)

func appErr(e *model.AppError) error {
	if e == nil {
		return nil
	}
	if e.StatusCode == http.StatusNotFound {
		return canvas.ErrNotFound
	}
	return e
}

func (b *backend) KVGet(key string) ([]byte, error) {
	v, err := b.api.KVGet(key)
	return v, appErr(err)
}

func (b *backend) KVSet(key string, value []byte, ttl time.Duration) error {
	_, err := b.api.KVSetWithOptions(key, value, model.PluginKVSetOptions{ExpireInSeconds: int64(ttl / time.Second)})
	return appErr(err)
}

func (b *backend) KVCompareAndSet(key string, oldValue, newValue []byte) (bool, error) {
	// Atomic with a nil OldValue sets only when the key is absent.
	ok, err := b.api.KVSetWithOptions(key, newValue, model.PluginKVSetOptions{Atomic: true, OldValue: oldValue})
	return ok, appErr(err)
}

func (b *backend) UploadFile(data []byte, channelID, filename string) (string, error) {
	fi, err := b.api.UploadFile(data, channelID, filename)
	if err != nil {
		return "", err
	}
	return fi.Id, nil
}

func (b *backend) GetFile(id string) ([]byte, error) {
	d, err := b.api.GetFile(id)
	return d, appErr(err)
}

func person(u *model.User) *canvas.Person {
	name := strings.TrimSpace(u.FirstName + " " + u.LastName)
	if name == "" {
		name = u.Username
	}
	detail := "@" + u.Username
	if u.Position != "" {
		detail = u.Position + " · @" + u.Username
	}
	// No avatar: Mattermost's image URL needs the viewer's session cookie, which a canvas on
	// another origin does not send. OpenCanvas shows initials. No e-mail, ever.
	return &canvas.Person{ID: u.Id, Name: name, Detail: detail, Guest: u.IsGuest(), Bot: u.IsBot, Deleted: u.DeleteAt != 0}
}

func (b *backend) User(id string) (*canvas.Person, error) {
	u, err := b.api.GetUser(id)
	if err != nil {
		return nil, appErr(err)
	}
	return person(u), nil
}

func (b *backend) IsChannelMember(channelID, userID string) (bool, error) {
	_, err := b.api.GetChannelMember(channelID, userID)
	if err == nil {
		return true, nil
	}
	if err.StatusCode == http.StatusNotFound {
		return false, nil
	}
	return false, err
}

// maxMembers bounds one members answer; larger channels are truncated (DESIGN.md §6).
const maxMembers = 5000

func (b *backend) ChannelMembers(channelID string) ([]canvas.Person, error) {
	var out []canvas.Person
	for page := 0; len(out) < maxMembers; page++ {
		users, err := b.api.GetUsersInChannel(channelID, "username", page, 200)
		if err != nil {
			return nil, err
		}
		for _, u := range users {
			out = append(out, *person(u))
		}
		if len(users) < 200 {
			break
		}
	}
	return out, nil
}

func (b *backend) CreateCanvasPost(rec *canvas.Record, userID string) (string, error) {
	post := &model.Post{
		UserId:    userID,
		ChannelId: rec.ChannelID,
		Type:      PostType,
		// Shown where the card component does not run (mobile apps, notifications, search).
		Message: cardMessage(rec.Title),
	}
	post.AddProp("opencanvas_file_id", rec.ID)
	post.AddProp("opencanvas_title", rec.Title)
	post.AddProp("opencanvas_template", rec.Template)
	created, err := b.api.CreatePost(post)
	if err != nil {
		return "", err
	}
	return created.Id, nil
}

// cardMessage is the card's text where the card component does not run (mobile apps,
// notifications, search).
func cardMessage(title string) string {
	return "Canvas: " + title + " (open it in Mattermost on the web or desktop)"
}

func (b *backend) UpdateCanvasPost(rec *canvas.Record) error {
	post, err := b.api.GetPost(rec.PostID)
	if err != nil {
		return err
	}
	post.Message = cardMessage(rec.Title)
	post.AddProp("opencanvas_title", rec.Title)
	_, err = b.api.UpdatePost(post)
	if err != nil {
		return err
	}
	return nil
}

func (b *backend) Publish(channelID, event string, payload map[string]any) {
	b.api.PublishWebSocketEvent(event, payload, &model.WebsocketBroadcast{ChannelId: channelID})
}

func (b *backend) PostURL(postID string) string {
	return strings.TrimRight(b.siteURL, "/") + "/_redirect/pl/" + postID
}
