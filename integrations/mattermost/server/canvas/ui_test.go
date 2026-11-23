// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

package canvas

// Server endpoints the approved webapp screens need (MM-02): the card's live info (S1), rename
// (S1b), the "Open in new window" page (S2, S7b), the start=page launch claim (S2f) and the
// card refresh after a save.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func (f *fake) UpdateCanvasPost(r *Record) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.updated = append(f.updated, *r)
	return nil
}

func (f *fake) Publish(channelID, event string, payload map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, event+"@"+channelID+":"+payload["fileId"].(string))
}

func userReq(method, path, user string, body any) *http.Request {
	var b []byte
	if body != nil {
		b, _ = json.Marshal(body)
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(b))
	if user != "" {
		r.Header.Set("Mattermost-User-Id", user)
	}
	return r
}

func create(t *testing.T, svc *Service, title, template string) *Record {
	t.Helper()
	rec, err := svc.CreateForUser("alice", "ch1", title, template)
	if err != nil {
		t.Fatal(err)
	}
	return rec
}

func TestLaunchAsksToSkipTheStartScreen(t *testing.T) {
	svc, _ := newSvc()
	rec := create(t, svc, "Sprint 43", "")
	res, err := svc.Launch("alice", rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(res.Token, ".")
	raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var c map[string]any
	_ = json.Unmarshal(raw, &c)
	if c["start"] != "page" {
		t.Fatalf("start claim = %v, want page (MM S2f)", c["start"])
	}
}

func TestCanvasInfoForTheCard(t *testing.T) {
	svc, _ := newSvc()
	rec := create(t, svc, "Sprint 42 planning", "meeting")

	w := do(svc, userReq("GET", "/api/v1/canvases/"+rec.ID, "bob", nil))
	if w.Code != 200 {
		t.Fatalf("member: %d %s", w.Code, w.Body)
	}
	var info map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &info)
	if info["title"] != "Sprint 42 planning" || info["template"] != "meeting" || info["canEdit"] != true ||
		info["updatedAt"] == nil || info["postId"] == nil {
		t.Fatalf("info %v", info)
	}
	if _, ok := info["fileInfoId"]; ok {
		t.Fatalf("file store ids are not the client's business: %v", info)
	}
	// A guest without access and an outsider: no access. An unknown id: gone.
	if w := do(svc, userReq("GET", "/api/v1/canvases/"+rec.ID, "gus", nil)); w.Code != 403 || !strings.Contains(w.Body.String(), "NO_ACCESS") {
		t.Fatalf("guest: %d %s", w.Code, w.Body)
	}
	if w := do(svc, userReq("GET", "/api/v1/canvases/"+rec.ID, "eve", nil)); w.Code != 403 {
		t.Fatalf("outsider: %d", w.Code)
	}
	if w := do(svc, userReq("GET", "/api/v1/canvases/mm_000000000000000000000000", "bob", nil)); w.Code != 404 || !strings.Contains(w.Body.String(), "GONE") {
		t.Fatalf("unknown: %d %s", w.Code, w.Body)
	}
}

func TestRenameUpdatesRecordAndCard(t *testing.T) {
	svc, f := newSvc()
	rec := create(t, svc, "Draft", "")

	w := do(svc, userReq("PATCH", "/api/v1/canvases/"+rec.ID, "bob", map[string]string{"title": "  Sprint\n43  plan "}))
	if w.Code != 200 {
		t.Fatalf("rename: %d %s", w.Code, w.Body)
	}
	got, _, _ := svc.store().Get(rec.ID)
	if got.Title != "Sprint 43 plan" {
		t.Fatalf("title %q", got.Title)
	}
	if len(f.updated) != 1 || f.updated[0].Title != "Sprint 43 plan" || f.updated[0].PostID == "" {
		t.Fatalf("card not updated: %+v", f.updated)
	}
	if w := do(svc, userReq("PATCH", "/api/v1/canvases/"+rec.ID, "eve", map[string]string{"title": "x"})); w.Code != 403 {
		t.Fatalf("outsider rename: %d", w.Code)
	}
	if w := do(svc, userReq("PATCH", "/api/v1/canvases/"+rec.ID, "bob", map[string]string{"title": "   "})); w.Code != 400 {
		t.Fatalf("empty title: %d", w.Code)
	}
}

func TestOpenPagePostsTheTokenInAForm(t *testing.T) {
	svc, _ := newSvc()
	rec := create(t, svc, "Sprint 42", "")

	w := do(svc, userReq("GET", "/open/"+rec.ID, "bob", nil))
	if w.Code != 200 {
		t.Fatalf("open: %d %s", w.Code, w.Body)
	}
	body := w.Body.String()
	if !strings.Contains(body, `action="https://canvas.acme.example/v1/launch"`) || !strings.Contains(body, `name="token" value="ey`) {
		t.Fatalf("form missing: %s", body)
	}
	if w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Header().Get("Content-Security-Policy"), "form-action https://canvas.acme.example") {
		t.Fatalf("headers %v", w.Header())
	}
	if !strings.Contains(w.Header().Get("Referrer-Policy"), "no-referrer") {
		t.Fatalf("referrer %v", w.Header())
	}
	// Not signed in, an outsider, unknown: no token, plain words.
	for _, u := range []string{"", "eve"} {
		w := do(svc, userReq("GET", "/open/"+rec.ID, u, nil))
		if w.Code == 200 || strings.Contains(w.Body.String(), `name="token"`) {
			t.Fatalf("user %q: %d %s", u, w.Code, w.Body)
		}
	}
}

func TestSaveRefreshesTheCards(t *testing.T) {
	svc, f := newSvc()
	rec := create(t, svc, "Sprint 42", "")
	w := do(svc, signed(svc, "PUT", "/oc/files/"+rec.ID, []byte("PK-v1"), t0))
	if w.Code != 200 {
		t.Fatalf("save: %d %s", w.Code, w.Body)
	}
	if len(f.events) != 1 || f.events[0] != "canvas_updated@ch1:"+rec.ID {
		t.Fatalf("events %v", f.events)
	}
}
