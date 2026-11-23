// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Package canvas is the Mattermost-independent core of the OpenCanvas plugin: launch tokens,
// callback signatures, the canvas index and the host callbacks (docs/05). The plugin's main
// package adapts Mattermost's plugin API to the Backend interface; everything here is tested
// with a fake backend and the standard library only.
package canvas

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// PluginID is the manifest id; callback URLs live under /plugins/<PluginID>.
const PluginID = "com.casualoffice.opencanvas"

// Config mirrors the plugin settings in plugin.json.
type Config struct {
	OpenCanvasURL    string
	OpenCanvasAPIURL string
	HostID           string
	SharedSecret     string
	CallbackSecret   string
	APIKey           string
	GuestRole        string
	TokenTTLMinutes  int
}

// Role values shared with OpenCanvas.
const (
	RoleNone    = "none"
	RoleView    = "view"
	RoleComment = "comment"
	RoleEdit    = "edit"
)

// Validate returns a normalised copy or an error naming the bad setting (never its value).
func (c Config) Validate() (Config, error) {
	c.OpenCanvasURL = strings.TrimRight(strings.TrimSpace(c.OpenCanvasURL), "/")
	c.OpenCanvasAPIURL = strings.TrimRight(strings.TrimSpace(c.OpenCanvasAPIURL), "/")
	c.HostID = strings.TrimSpace(c.HostID)
	if c.HostID == "" {
		c.HostID = "mattermost"
	}
	for name, v := range map[string]string{"OpenCanvasURL": c.OpenCanvasURL, "OpenCanvasAPIURL": c.OpenCanvasAPIURL} {
		if v == "" && name == "OpenCanvasAPIURL" {
			continue
		}
		u, err := url.Parse(v)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			return c, fmt.Errorf("%s must be an http(s) URL", name)
		}
	}
	if c.OpenCanvasAPIURL == "" {
		c.OpenCanvasAPIURL = c.OpenCanvasURL
	}
	if len(c.SharedSecret) < 32 {
		return c, errors.New("SharedSecret must be at least 32 characters")
	}
	switch c.GuestRole {
	case "":
		c.GuestRole = RoleNone
	case RoleNone, RoleView, RoleComment, RoleEdit:
	default:
		return c, errors.New("GuestRole must be none, view, comment or edit")
	}
	if c.TokenTTLMinutes <= 0 {
		c.TokenTTLMinutes = 10
	}
	if c.TokenTTLMinutes > 60 {
		c.TokenTTLMinutes = 60
	}
	return c, nil
}

// TokenTTL is the launch token lifetime.
func (c Config) TokenTTL() time.Duration { return time.Duration(c.TokenTTLMinutes) * time.Minute }

// CallbackKey is the HMAC key OpenCanvas signs callbacks with: hosts.toml callback_secret if
// set, else jwt_secret (crates/oc-server/src/hosts.rs signing_secret).
func (c Config) CallbackKey() []byte {
	if c.CallbackSecret != "" {
		return []byte(c.CallbackSecret)
	}
	return []byte(c.SharedSecret)
}
