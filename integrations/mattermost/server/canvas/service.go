// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

package canvas

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"
)

// Limits.
const (
	MaxFileBytes  = 100 << 20 // the OpenCanvas .ocanvas read limit (docs/05 §6)
	MaxAssetBytes = 10 << 20  // docs/05 §6 per-asset limit
	MaxTitleRunes = 120
)

// Service serves the plugin's HTTP surface. Two kinds of caller:
//
//   - OpenCanvas, server to server, under /oc/...: authenticated ONLY by the v2 HMAC signature.
//     Mattermost strips the Authorization header before a plugin sees a request
//     (server/channels/app/plugin_requests.go), so the callbackToken bearer never arrives.
//   - Mattermost users, under /api/v1/...: authenticated by Mattermost, which sets the
//     Mattermost-User-Id header only for a valid session and deletes any client-supplied one.
type Service struct {
	Cfg Config
	B   Backend
	// SiteURL of Mattermost (ServiceSettings.SiteURL); its path is the subpath callbacks are
	// signed under.
	SiteURL string
	Now     func() time.Time
	// OC calls OpenCanvas (role and member changes). Nil = not configured.
	OC *Client
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Service) store() Store { return Store{B: s.B} }

// CallbackBase is the hosts.toml callback_base for this Mattermost server.
func (s *Service) CallbackBase() string {
	return strings.TrimRight(s.SiteURL, "/") + "/plugins/" + PluginID + "/oc"
}

// signedPaths is the path?query OpenCanvas signed: the full public path of the callback,
// i.e. Mattermost's subpath + /plugins/<id> + the path the plugin sees (Mattermost strips
// that prefix before ServeHTTP).
func (s *Service) signedPaths(r *http.Request) []string {
	sub := ""
	if u, err := url.Parse(s.SiteURL); err == nil {
		sub = strings.TrimRight(u.Path, "/")
	}
	p := r.URL.EscapedPath()
	full := sub + "/plugins/" + PluginID + p
	if r.URL.RawQuery != "" {
		full += "?" + r.URL.RawQuery
	}
	return []string{full}
}

// ServeHTTP routes a request whose /plugins/<id> prefix Mattermost already removed.
func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	p := r.URL.Path
	switch {
	case strings.HasPrefix(p, "/oc/"):
		s.serveCallback(w, r, strings.TrimPrefix(p, "/oc"))
	case strings.HasPrefix(p, "/api/v1/"):
		s.serveUserAPI(w, r, strings.TrimPrefix(p, "/api/v1"))
	default:
		http.NotFound(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func errJSON(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

// ---------------------------------------------------------------- OpenCanvas callbacks

func (s *Service) serveCallback(w http.ResponseWriter, r *http.Request, p string) {
	limit := int64(MaxFileBytes)
	body, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		errJSON(w, http.StatusBadRequest, "READ_FAILED")
		return
	}
	if int64(len(body)) > limit {
		errJSON(w, http.StatusRequestEntityTooLarge, "TOO_LARGE")
		return
	}
	if err := VerifySignature(s.Cfg.CallbackKey(), r.Header.Get("X-OpenCanvas-Signature"), r.Method, s.signedPaths(r), body, s.now()); err != nil {
		errJSON(w, http.StatusUnauthorized, "SIGNATURE_INVALID")
		return
	}
	parts := strings.Split(strings.Trim(p, "/"), "/")
	switch {
	case len(parts) == 1 && parts[0] == "access" && r.Method == http.MethodPost:
		s.cbAccess(w, body)
	case len(parts) >= 2 && parts[0] == "files":
		// OpenCanvas also sends the callback token in X-OpenCanvas-Callback-Token, since
		// Mattermost strips Authorization. When present it must be ours and for this file;
		// older OpenCanvas servers send none and are authenticated by the signature alone.
		if ct := r.Header.Get("X-OpenCanvas-Callback-Token"); ct != "" {
			if _, err := VerifyCallbackToken(s.Cfg, ct, parts[1], s.now()); err != nil {
				errJSON(w, http.StatusUnauthorized, "CALLBACK_TOKEN_INVALID")
				return
			}
		}
		rec, raw, err := s.store().Get(parts[1])
		if errors.Is(err, ErrNotFound) {
			errJSON(w, http.StatusNotFound, "FILE_NOT_FOUND")
			return
		} else if err != nil {
			errJSON(w, http.StatusInternalServerError, "INTERNAL")
			return
		}
		switch {
		case len(parts) == 2 && r.Method == http.MethodGet:
			s.cbLoad(w, rec)
		case len(parts) == 2 && r.Method == http.MethodPut:
			s.cbSave(w, r, rec, raw, body)
		case len(parts) == 3 && parts[2] == "members" && r.Method == http.MethodGet:
			s.cbMembers(w, r, rec)
		case len(parts) == 3 && parts[2] == "copies" && r.Method == http.MethodPost:
			s.cbCopy(w, rec, body)
		case len(parts) == 3 && parts[2] == "assets" && r.Method == http.MethodPost:
			s.cbAssetUpload(w, r, rec, body)
		case len(parts) == 4 && parts[2] == "assets" && r.Method == http.MethodGet:
			s.serveAsset(w, rec, parts[3])
		default:
			errJSON(w, http.StatusMethodNotAllowed, "NOT_IMPLEMENTED")
		}
	default:
		errJSON(w, http.StatusNotFound, "NOT_FOUND")
	}
}

func (s *Service) cbLoad(w http.ResponseWriter, rec *Record) {
	if rec.FileInfoID == "" {
		if rec.Template == "meeting" {
			// No per-launch template for storage = "host" hosts (server gap, DESIGN.md §8):
			// the first load of a meeting-notes canvas is a Markdown skeleton instead.
			w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
			_, _ = io.WriteString(w, MeetingNotesMarkdown(rec.Title))
			return
		}
		errJSON(w, http.StatusNotFound, "EMPTY") // docs/05 §5: 404 = new empty canvas
		return
	}
	data, err := s.B.GetFile(rec.FileInfoID)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "INTERNAL")
		return
	}
	w.Header().Set("Content-Type", "application/vnd.opencanvas+zip")
	w.Header().Set("ETag", `"`+rec.VersionString()+`"`)
	_, _ = w.Write(data)
}

func unquote(v string) string {
	return strings.Trim(strings.TrimPrefix(strings.TrimSpace(v), "W/"), `"`)
}

func (s *Service) cbSave(w http.ResponseWriter, r *http.Request, rec *Record, raw, body []byte) {
	idem := r.Header.Get("Idempotency-Key")
	if idem != "" {
		if v, _ := s.B.KVGet(keyIdem(rec.ID, idem)); v != nil {
			writeJSON(w, http.StatusOK, map[string]string{"version": string(v)})
			return
		}
	}
	if m := r.Header.Get("If-Match"); m != "" && unquote(m) != rec.VersionString() {
		writeJSON(w, http.StatusConflict, map[string]string{"version": rec.VersionString()})
		return
	}
	if len(body) == 0 {
		errJSON(w, http.StatusBadRequest, "EMPTY_BODY")
		return
	}
	fid, err := s.B.UploadFile(body, rec.ChannelID, safeFilename(rec.Title)+".ocanvas")
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "INTERNAL")
		return
	}
	next := *rec
	next.Version++
	if rec.FileInfoID != "" {
		next.History = append([]string{rec.FileInfoID}, rec.History...)
		if len(next.History) > MaxHistory {
			next.History = next.History[:MaxHistory]
		}
	}
	next.FileInfoID, next.Size, next.UpdatedAt = fid, len(body), s.now().UnixMilli()
	ok, err := s.store().Update(raw, &next)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "INTERNAL")
		return
	}
	if !ok { // someone else saved between our read and write
		cur, _, _ := s.store().Get(rec.ID)
		v := ""
		if cur != nil {
			v = cur.VersionString()
		}
		writeJSON(w, http.StatusConflict, map[string]string{"version": v})
		return
	}
	if idem != "" {
		_ = s.B.KVSet(keyIdem(rec.ID, idem), []byte(next.VersionString()), 24*time.Hour)
	}
	writeJSON(w, http.StatusOK, map[string]string{"version": next.VersionString()})
}

// RoleFor decides a user's role on a canvas: channel members edit, guests get the configured
// guest role, everyone else (including deactivated users and bots) none.
func (s *Service) RoleFor(rec *Record, userID string) (string, *Person, error) {
	u, err := s.B.User(userID)
	if errors.Is(err, ErrNotFound) {
		return RoleNone, nil, nil
	} else if err != nil {
		return RoleNone, nil, err
	}
	if u.Deleted || u.Bot {
		return RoleNone, u, nil
	}
	member, err := s.B.IsChannelMember(rec.ChannelID, userID)
	if err != nil || !member {
		return RoleNone, u, err
	}
	if u.Guest {
		return s.Cfg.GuestRole, u, nil
	}
	return RoleEdit, u, nil
}

func (s *Service) cbAccess(w http.ResponseWriter, body []byte) {
	var in struct {
		FileID string `json:"fileId"`
		UserID string `json:"userId"`
	}
	if json.Unmarshal(body, &in) != nil || in.FileID == "" || in.UserID == "" {
		errJSON(w, http.StatusBadRequest, "BAD_REQUEST")
		return
	}
	rec, _, err := s.store().Get(in.FileID)
	if errors.Is(err, ErrNotFound) {
		writeJSON(w, http.StatusOK, map[string]string{"role": RoleNone})
		return
	} else if err != nil {
		errJSON(w, http.StatusInternalServerError, "INTERNAL")
		return
	}
	role, _, err := s.RoleFor(rec, in.UserID)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "INTERNAL")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"role": role})
}

// visibleMembers is everyone who may open the canvas: channel members minus bots and
// deactivated users, minus guests when guests have no access.
func (s *Service) visibleMembers(rec *Record) ([]Person, error) {
	all, err := s.B.ChannelMembers(rec.ChannelID)
	if err != nil {
		return nil, err
	}
	out := make([]Person, 0, len(all))
	for _, p := range all {
		if p.Bot || p.Deleted || (p.Guest && s.Cfg.GuestRole == RoleNone) {
			continue
		}
		out = append(out, p)
	}
	return out, nil
}

func (s *Service) cbMembers(w http.ResponseWriter, r *http.Request, rec *Record) {
	members, err := s.visibleMembers(rec)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "INTERNAL")
		return
	}
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	limit := MaxTokenMembers
	if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 && n < limit {
		limit = n
	}
	out := []Person{}
	for _, p := range members {
		if q != "" && !strings.Contains(strings.ToLower(p.Name), q) && !strings.Contains(strings.ToLower(p.Detail), q) {
			continue
		}
		out = append(out, p)
		if len(out) == limit {
			break
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Service) cbCopy(w http.ResponseWriter, rec *Record, body []byte) {
	cp, err := s.createCanvas(rec.ChannelID, rec.CreatorID, rec.Title+" (conflict copy)", "", body)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "INTERNAL")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"fileId": cp.ID, "url": s.B.PostURL(cp.PostID)})
}

func (s *Service) cbAssetUpload(w http.ResponseWriter, r *http.Request, rec *Record, body []byte) {
	mt, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || !strings.HasPrefix(mt, "multipart/") {
		errJSON(w, http.StatusBadRequest, "MULTIPART_REQUIRED")
		return
	}
	mr := multipart.NewReader(strings.NewReader(string(body)), params["boundary"])
	for {
		part, err := mr.NextPart()
		if err != nil {
			errJSON(w, http.StatusBadRequest, "FILE_FIELD_REQUIRED")
			return
		}
		if part.FormName() != "file" {
			continue
		}
		data, err := io.ReadAll(io.LimitReader(part, MaxAssetBytes+1))
		if err != nil {
			errJSON(w, http.StatusBadRequest, "READ_FAILED")
			return
		}
		if len(data) > MaxAssetBytes {
			errJSON(w, http.StatusRequestEntityTooLarge, "ASSET_TOO_LARGE")
			return
		}
		ct := part.Header.Get("Content-Type")
		if ct == "" {
			ct = http.DetectContentType(data)
		}
		name := safeFilename(part.FileName())
		fid, err := s.B.UploadFile(data, rec.ChannelID, name)
		if err != nil {
			errJSON(w, http.StatusInternalServerError, "INTERNAL")
			return
		}
		assetID := "a_" + fid
		ar, _ := json.Marshal(assetRecord{FileInfoID: fid, Mime: ct, Size: len(data)})
		if err := s.B.KVSet(keyAsset(rec.ID, assetID), ar, 0); err != nil {
			errJSON(w, http.StatusInternalServerError, "INTERNAL")
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{
			"assetId": assetID,
			"url":     s.CallbackBase() + "/files/" + url.PathEscape(rec.ID) + "/assets/" + url.PathEscape(assetID),
			"mime":    ct,
			"size":    len(data),
		})
		return
	}
}

// serveAsset answers only for assets uploaded to THIS canvas (the KV binding), so a
// signature for one canvas never reads an arbitrary Mattermost file.
func (s *Service) serveAsset(w http.ResponseWriter, rec *Record, assetID string) {
	raw, err := s.B.KVGet(keyAsset(rec.ID, assetID))
	if err != nil || raw == nil {
		errJSON(w, http.StatusNotFound, "ASSET_NOT_FOUND")
		return
	}
	var ar assetRecord
	if json.Unmarshal(raw, &ar) != nil {
		errJSON(w, http.StatusInternalServerError, "INTERNAL")
		return
	}
	data, err := s.B.GetFile(ar.FileInfoID)
	if err != nil {
		errJSON(w, http.StatusNotFound, "ASSET_NOT_FOUND")
		return
	}
	ct := ar.Mime
	if !strings.HasPrefix(ct, "image/") || ct == "image/svg+xml" {
		ct = "application/octet-stream"
		w.Header().Set("Content-Disposition", "attachment")
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Cache-Control", "private, max-age=300")
	_, _ = w.Write(data)
}

// ---------------------------------------------------------------- Mattermost user API

func (s *Service) serveUserAPI(w http.ResponseWriter, r *http.Request, p string) {
	userID := r.Header.Get("Mattermost-User-Id") // set by Mattermost for a valid session only
	if userID == "" {
		errJSON(w, http.StatusUnauthorized, "NOT_SIGNED_IN")
		return
	}
	parts := strings.Split(strings.Trim(p, "/"), "/")
	switch {
	case len(parts) == 1 && parts[0] == "canvases" && r.Method == http.MethodPost:
		var in struct {
			ChannelID string `json:"channelId"`
			Title     string `json:"title"`
			Template  string `json:"template"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&in); err != nil || in.ChannelID == "" {
			errJSON(w, http.StatusBadRequest, "BAD_REQUEST")
			return
		}
		rec, err := s.CreateForUser(userID, in.ChannelID, in.Title, in.Template)
		s.answerCreate(w, rec, err)
	case len(parts) == 3 && parts[0] == "channels" && parts[2] == "canvases" && r.Method == http.MethodGet:
		s.listChannel(w, userID, parts[1])
	case len(parts) == 3 && parts[0] == "canvases" && parts[2] == "launch" && r.Method == http.MethodPost:
		s.launch(w, userID, parts[1])
	case len(parts) == 4 && parts[0] == "canvases" && parts[2] == "assets" && r.Method == http.MethodGet:
		// The editor shows images by URL in the browser: a signed-in channel member may read
		// this canvas's assets with their Mattermost session.
		rec, _, err := s.store().Get(parts[1])
		if err != nil {
			errJSON(w, http.StatusNotFound, "FILE_NOT_FOUND")
			return
		}
		if role, _, err := s.RoleFor(rec, userID); err != nil || role == RoleNone {
			errJSON(w, http.StatusNotFound, "FILE_NOT_FOUND")
			return
		}
		s.serveAsset(w, rec, parts[3])
	default:
		errJSON(w, http.StatusNotFound, "NOT_FOUND")
	}
}

// ErrNoAccess: the user is not allowed to create or open a canvas there.
var ErrNoAccess = errors.New("no access")

// CreateForUser creates a canvas in a channel the user may edit in, and posts its card.
func (s *Service) CreateForUser(userID, channelID, title, template string) (*Record, error) {
	if template != "" && template != "meeting" {
		return nil, fmt.Errorf("unknown template")
	}
	probe := &Record{ChannelID: channelID}
	role, _, err := s.RoleFor(probe, userID)
	if err != nil {
		return nil, err
	}
	if role != RoleEdit {
		return nil, ErrNoAccess
	}
	return s.createCanvas(channelID, userID, title, template, nil)
}

func (s *Service) answerCreate(w http.ResponseWriter, rec *Record, err error) {
	switch {
	case errors.Is(err, ErrNoAccess):
		errJSON(w, http.StatusForbidden, "NO_ACCESS")
	case err != nil:
		errJSON(w, http.StatusBadRequest, "CREATE_FAILED")
	default:
		writeJSON(w, http.StatusCreated, rec)
	}
}

// CleanTitle trims a title to one line of at most MaxTitleRunes.
func CleanTitle(t, fallback string) string {
	t = strings.Join(strings.Fields(t), " ")
	if t == "" {
		t = fallback
	}
	if r := []rune(t); len(r) > MaxTitleRunes {
		t = string(r[:MaxTitleRunes])
	}
	return t
}

func (s *Service) createCanvas(channelID, userID, title, template string, initial []byte) (*Record, error) {
	fallback := "Untitled canvas"
	if template == "meeting" {
		fallback = "Meeting notes " + s.now().UTC().Format("2006-01-02")
	}
	id, err := NewFileID()
	if err != nil {
		return nil, err
	}
	now := s.now().UnixMilli()
	rec := &Record{ID: id, ChannelID: channelID, Title: CleanTitle(title, fallback), Template: template, CreatorID: userID, CreatedAt: now, UpdatedAt: now}
	if initial != nil {
		fid, err := s.B.UploadFile(initial, channelID, safeFilename(rec.Title)+".ocanvas")
		if err != nil {
			return nil, err
		}
		rec.FileInfoID, rec.Version, rec.Size = fid, 1, len(initial)
	}
	if err := s.store().Create(rec); err != nil {
		return nil, err
	}
	postID, err := s.B.CreateCanvasPost(rec, userID)
	if err != nil {
		return nil, err
	}
	for i := 0; i < 4; i++ { // record the post id; the canvas is usable even if this fails
		cur, raw, err := s.store().Get(rec.ID)
		if err != nil {
			break
		}
		cur.PostID = postID
		if ok, _ := s.store().Update(raw, cur); ok {
			rec = cur
			break
		}
	}
	return rec, nil
}

func (s *Service) listChannel(w http.ResponseWriter, userID, channelID string) {
	role, _, err := s.RoleFor(&Record{ChannelID: channelID}, userID)
	if err != nil || role == RoleNone {
		errJSON(w, http.StatusForbidden, "NO_ACCESS")
		return
	}
	ids, err := s.store().ChannelFiles(channelID)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "INTERNAL")
		return
	}
	out := []*Record{}
	for _, id := range ids {
		if rec, _, err := s.store().Get(id); err == nil {
			rec.History, rec.FileInfoID = nil, "" // not the client's business
			out = append(out, rec)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// LaunchResponse is what the webapp form-POSTs into its iframe (docs/05 §4 option A).
type LaunchResponse struct {
	LaunchURL string `json:"launchUrl"`
	Token     string `json:"token"`
	ExpiresAt int64  `json:"expiresAt"`
	Role      string `json:"role"`
}

// Launch mints a token after the membership check. POST, not GET: a token is never put in a
// URL, and Mattermost requires a CSRF token for cookie-authenticated POSTs.
func (s *Service) Launch(userID, fileID string) (*LaunchResponse, error) {
	rec, _, err := s.store().Get(fileID)
	if err != nil {
		return nil, err
	}
	role, me, err := s.RoleFor(rec, userID)
	if err != nil {
		return nil, err
	}
	if role == RoleNone {
		return nil, ErrNoAccess
	}
	var members []Person
	if all, err := s.visibleMembers(rec); err == nil && len(all) <= MaxTokenMembers {
		members = all
	}
	tok, claims, err := MintLaunch(s.Cfg, LaunchInput{File: rec, User: *me, Role: role, Members: members}, s.now())
	if err != nil {
		return nil, err
	}
	return &LaunchResponse{LaunchURL: s.Cfg.OpenCanvasURL + "/v1/launch", Token: tok, ExpiresAt: claims.Exp, Role: role}, nil
}

func (s *Service) launch(w http.ResponseWriter, userID, fileID string) {
	res, err := s.Launch(userID, fileID)
	switch {
	case errors.Is(err, ErrNotFound), errors.Is(err, ErrNoAccess):
		// Same answer for both: do not reveal that a canvas exists to non-members.
		errJSON(w, http.StatusNotFound, "NO_ACCESS")
	case err != nil:
		errJSON(w, http.StatusInternalServerError, "INTERNAL")
	default:
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, res)
	}
}

// NewFileID returns "mm_" + 24 lowercase hex characters.
func NewFileID() (string, error) {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return fmt.Sprintf("mm_%x", b), nil
}

func safeFilename(t string) string {
	t = path.Base(strings.Map(func(r rune) rune {
		if r < 0x20 || strings.ContainsRune(`/\:*?"<>|`, r) {
			return '_'
		}
		return r
	}, t))
	if t == "" || t == "." || t == "/" {
		t = "canvas"
	}
	return t
}
