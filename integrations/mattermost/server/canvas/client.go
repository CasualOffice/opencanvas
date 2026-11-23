// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

package canvas

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// Client calls the OpenCanvas server-to-server API (docs/05 §7).
type Client struct {
	BaseURL string // Config.OpenCanvasAPIURL
	HostID  string
	APIKey  string
	HTTP    *http.Client
}

// NewClient returns nil when no API key is configured (live revocation is then off and access
// ends when the session token expires).
func NewClient(cfg Config) *Client {
	if cfg.APIKey == "" {
		return nil
	}
	return &Client{BaseURL: cfg.OpenCanvasAPIURL, HostID: cfg.HostID, APIKey: cfg.APIKey,
		HTTP: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}}}
}

func (c *Client) post(path string, body any) error {
	raw, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, c.BaseURL+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-OpenCanvas-Host", c.HostID)
	req.Header.Set("X-OpenCanvas-Key", c.APIKey)
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return fmt.Errorf("opencanvas answered %d", res.StatusCode)
	}
	return nil
}

// SetRole changes a user's role on a file live ("none" closes their session).
func (c *Client) SetRole(fileID, userID, role string) error {
	return c.post("/v1/files/"+url.PathEscape(fileID)+"/role", map[string]string{"userId": userID, "role": role})
}

// InvalidateMembers drops OpenCanvas's cached member list for a file.
func (c *Client) InvalidateMembers(fileID string) error {
	return c.post("/v1/files/"+url.PathEscape(fileID)+"/members/invalidate", map[string]string{})
}

// UserLeftChannel ends the user's access to every canvas of the channel at once. Errors are
// returned per file count only (no ids or secrets in logs).
func (s *Service) UserLeftChannel(channelID, userID string) (failed int) {
	ids, _ := s.store().ChannelFiles(channelID)
	for _, id := range ids {
		if s.OC == nil {
			return 0
		}
		if s.OC.SetRole(id, userID, RoleNone) != nil {
			failed++
		}
	}
	return failed
}

// ChannelMembershipChanged refreshes the @mention lists of the channel's canvases.
func (s *Service) ChannelMembershipChanged(channelID string) (failed int) {
	ids, _ := s.store().ChannelFiles(channelID)
	for _, id := range ids {
		if s.OC == nil {
			return 0
		}
		if s.OC.InvalidateMembers(id) != nil {
			failed++
		}
	}
	return failed
}
