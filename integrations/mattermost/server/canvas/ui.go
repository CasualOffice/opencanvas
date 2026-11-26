// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

package canvas

// Endpoints behind the approved webapp screens (MM-02, docs/prototypes/mattermost-approved):
// the card's live info (S1), rename (S1b), the "Open in new window" page (S2, S7b) and the
// WebSocket event that refreshes cards after a save.

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"html"
	"io"
	"net/http"
	"strings"
)

// EventCanvasUpdated is the plugin WebSocket event (webapp: custom_<plugin id>_canvas_updated).
const EventCanvasUpdated = "canvas_updated"

// Info is what a card shows: never the file-store ids.
type Info struct {
	ID        string `json:"id"`
	ChannelID string `json:"channelId"`
	Title     string `json:"title"`
	Template  string `json:"template"`
	PostID    string `json:"postId"`
	Version   int64  `json:"version"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
	// CanEdit: the viewer may rename it (and edits it in the editor).
	CanEdit bool   `json:"canEdit"`
	Role    string `json:"role"`
}

func infoOf(rec *Record, role string) Info {
	return Info{ID: rec.ID, ChannelID: rec.ChannelID, Title: rec.Title, Template: rec.Template, PostID: rec.PostID,
		Version: rec.Version, CreatedAt: rec.CreatedAt, UpdatedAt: rec.UpdatedAt, CanEdit: role == RoleEdit, Role: role}
}

func (s *Service) announce(rec *Record) {
	s.B.Publish(rec.ChannelID, EventCanvasUpdated, map[string]any{
		"fileId": rec.ID, "title": rec.Title, "updatedAt": rec.UpdatedAt, "version": rec.Version,
	})
}

// info answers the card (S1d): 404 GONE for an unknown or deleted canvas, 403 NO_ACCESS when
// the viewer may not open it. The card already carries the title and id in its post, so
// telling the two apart reveals nothing the post does not.
func (s *Service) info(w http.ResponseWriter, userID, fileID string) {
	rec, _, err := s.store().Get(fileID)
	if errors.Is(err, ErrNotFound) {
		errJSON(w, http.StatusNotFound, "GONE")
		return
	} else if err != nil {
		errJSON(w, http.StatusInternalServerError, "INTERNAL")
		return
	}
	role, _, err := s.RoleFor(rec, userID)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "INTERNAL")
		return
	}
	if role == RoleNone {
		errJSON(w, http.StatusForbidden, "NO_ACCESS")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, infoOf(rec, role))
}

// rename (S1b "Rename", creator and editors): the record and the card's post.
func (s *Service) rename(w http.ResponseWriter, r *http.Request, userID, fileID string) {
	var in struct {
		Title string `json:"title"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&in) != nil {
		errJSON(w, http.StatusBadRequest, "BAD_REQUEST")
		return
	}
	title := CleanTitle(in.Title, "")
	if title == "" {
		errJSON(w, http.StatusBadRequest, "TITLE_REQUIRED")
		return
	}
	for i := 0; i < 4; i++ {
		rec, raw, err := s.store().Get(fileID)
		if errors.Is(err, ErrNotFound) {
			errJSON(w, http.StatusNotFound, "GONE")
			return
		} else if err != nil {
			errJSON(w, http.StatusInternalServerError, "INTERNAL")
			return
		}
		role, _, err := s.RoleFor(rec, userID)
		if err != nil {
			errJSON(w, http.StatusInternalServerError, "INTERNAL")
			return
		}
		if role != RoleEdit {
			errJSON(w, http.StatusForbidden, "NO_ACCESS")
			return
		}
		next := *rec
		next.Title = title
		ok, err := s.store().Update(raw, &next)
		if err != nil {
			errJSON(w, http.StatusInternalServerError, "INTERNAL")
			return
		}
		if !ok {
			continue // a save landed in between; read again
		}
		if next.PostID != "" {
			if err := s.B.UpdateCanvasPost(&next); err != nil {
				errJSON(w, http.StatusInternalServerError, "INTERNAL")
				return
			}
		}
		s.announce(&next)
		writeJSON(w, http.StatusOK, infoOf(&next, role))
		return
	}
	errJSON(w, http.StatusConflict, "BUSY")
}

// openScript submits the form once the page has loaded; allowed by its hash in the CSP.
const openScript = `document.getElementById("oc").submit();`

func scriptHash(src string) string {
	h := sha256.Sum256([]byte(src))
	return "'sha256-" + base64.StdEncoding.EncodeToString(h[:]) + "'"
}

// serveOpenPage is "Open in new window" (S2; "Open in your browser" in the Desktop app, S7b):
// a GET with the Mattermost session that answers a page which form-POSTs a fresh launch token
// to OpenCanvas. The token is in the page body, never in a URL, and the page is not cached.
func (s *Service) serveOpenPage(w http.ResponseWriter, r *http.Request, fileID string) {
	userID := r.Header.Get("Mattermost-User-Id") // set by Mattermost for a valid session only
	page := func(status int, title, text string) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>`+
			html.EscapeString(title)+`</title></head><body style="font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#3f4350">`+
			`<h1 style="font-size:20px;margin:0 0 8px">`+html.EscapeString(title)+`</h1><p style="margin:0">`+html.EscapeString(text)+`</p></body></html>`)
	}
	if userID == "" {
		page(http.StatusUnauthorized, "Sign in to your Mattermost account first", "Sign in to your Mattermost account in this browser, then open the canvas again.")
		return
	}
	res, err := s.Launch(userID, strings.Trim(fileID, "/"))
	switch {
	case errors.Is(err, ErrNotFound), errors.Is(err, ErrNoAccess):
		page(http.StatusNotFound, "You don't have access to this canvas", "Ask someone in the channel to add you.")
		return
	case err != nil:
		page(http.StatusInternalServerError, "Canvases aren't available right now", "Try again later. If it keeps happening, tell your Mattermost admin.")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src "+scriptHash(openScript)+
		"; form-action "+s.Cfg.OpenCanvasURL+"; base-uri 'none'; frame-ancestors 'none'")
	_, _ = io.WriteString(w, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Opening canvas</title></head><body>`+
		`<form id="oc" method="post" action="`+html.EscapeString(res.LaunchURL)+`">`+
		`<input type="hidden" name="token" value="`+html.EscapeString(res.Token)+`">`+
		`<noscript><button type="submit">Open the canvas</button></noscript></form>`+
		`<script>`+openScript+`</script></body></html>`)
}
