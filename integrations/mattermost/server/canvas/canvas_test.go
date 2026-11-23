// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

package canvas

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------- fake Mattermost

type fake struct {
	mu      sync.Mutex
	kv      map[string][]byte
	files   map[string][]byte
	users   map[string]*Person
	members map[string]map[string]bool // channel -> user
	posts   []*Record
	seq     int
}

func newFake() *fake {
	f := &fake{kv: map[string][]byte{}, files: map[string][]byte{}, users: map[string]*Person{},
		members: map[string]map[string]bool{"ch1": {}}}
	f.addUser(&Person{ID: "alice", Name: "Alice Doe", Detail: "@alice"}, "ch1")
	f.addUser(&Person{ID: "bob", Name: "Bob Roe", Detail: "@bob"}, "ch1")
	f.addUser(&Person{ID: "gus", Name: "Gus Guest", Detail: "@gus", Guest: true}, "ch1")
	f.addUser(&Person{ID: "bot", Name: "Robot", Bot: true}, "ch1")
	f.addUser(&Person{ID: "eve", Name: "Eve Outsider", Detail: "@eve"}, "")
	return f
}

func (f *fake) addUser(p *Person, ch string) {
	f.users[p.ID] = p
	if ch != "" {
		f.members[ch][p.ID] = true
	}
}

func (f *fake) KVGet(k string) ([]byte, error) { f.mu.Lock(); defer f.mu.Unlock(); return f.kv[k], nil }
func (f *fake) KVSet(k string, v []byte, _ time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.kv[k] = v
	return nil
}
func (f *fake) KVCompareAndSet(k string, old, nv []byte) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	cur, ok := f.kv[k]
	if (old == nil && ok) || (old != nil && !bytes.Equal(cur, old)) {
		return false, nil
	}
	f.kv[k] = nv
	return true, nil
}
func (f *fake) UploadFile(d []byte, ch, name string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seq++
	id := "fi" + strconv.Itoa(f.seq)
	f.files[id] = append([]byte(nil), d...)
	return id, nil
}
func (f *fake) GetFile(id string) ([]byte, error) {
	if d, ok := f.files[id]; ok {
		return d, nil
	}
	return nil, ErrNotFound
}
func (f *fake) User(id string) (*Person, error) {
	if u, ok := f.users[id]; ok {
		c := *u
		return &c, nil
	}
	return nil, ErrNotFound
}
func (f *fake) IsChannelMember(ch, u string) (bool, error) { return f.members[ch][u], nil }
func (f *fake) ChannelMembers(ch string) ([]Person, error) {
	var out []Person
	for _, id := range []string{"alice", "bob", "gus", "bot", "eve"} {
		if f.members[ch][id] {
			out = append(out, *f.users[id])
		}
	}
	return out, nil
}
func (f *fake) CreateCanvasPost(r *Record, _ string) (string, error) {
	f.posts = append(f.posts, r)
	return "post" + strconv.Itoa(len(f.posts)), nil
}
func (f *fake) PostURL(id string) string { return "https://chat.acme.example/_redirect/pl/" + id }

// ---------------------------------------------------------------- helpers

var t0 = time.Unix(1_800_000_000, 0)

func testCfg() Config {
	c, err := Config{OpenCanvasURL: "https://canvas.acme.example", HostID: "acme-mm",
		SharedSecret: strings.Repeat("s", 40)}.Validate()
	if err != nil {
		panic(err)
	}
	return c
}

func newSvc() (*Service, *fake) {
	f := newFake()
	return &Service{Cfg: testCfg(), B: f, SiteURL: "https://chat.acme.example", Now: func() time.Time { return t0 }}, f
}

// signed builds a callback request the way OpenCanvas does: the signature covers the full
// public path, the plugin sees the path after /plugins/<id>.
func signed(svc *Service, method, pluginPath string, body []byte, at time.Time) *http.Request {
	r := httptest.NewRequest(method, pluginPath, bytes.NewReader(body))
	full := "/plugins/" + PluginID + pluginPath
	ts := at.Unix()
	r.Header.Set("X-OpenCanvas-Signature", fmt.Sprintf("t=%d,v1=00,v2=%s", ts, SignV2(svc.Cfg.CallbackKey(), ts, method, full, body)))
	return r
}

func do(svc *Service, r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	svc.ServeHTTP(w, r)
	return w
}

func mustCreate(t *testing.T, svc *Service, template string) *Record {
	t.Helper()
	rec, err := svc.CreateForUser("alice", "ch1", "Sprint notes", template)
	if err != nil {
		t.Fatal(err)
	}
	return rec
}

func decodeJWT(t *testing.T, tok string, key []byte) map[string]any {
	t.Helper()
	p := strings.Split(tok, ".")
	if len(p) != 3 {
		t.Fatalf("not a JWT")
	}
	m := hmac.New(sha256.New, key)
	m.Write([]byte(p[0] + "." + p[1]))
	if b64.EncodeToString(m.Sum(nil)) != p[2] {
		t.Fatal("bad HS256 signature")
	}
	h, _ := b64.DecodeString(p[0])
	if string(h) != `{"alg":"HS256","typ":"JWT"}` {
		t.Fatalf("header %s", h)
	}
	raw, _ := b64.DecodeString(p[1])
	var c map[string]any
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

// ---------------------------------------------------------------- tokens

func TestLaunchTokenClaims(t *testing.T) {
	svc, _ := newSvc()
	rec := mustCreate(t, svc, "")
	res, err := svc.Launch("alice", rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if res.LaunchURL != "https://canvas.acme.example/v1/launch" {
		t.Fatal(res.LaunchURL)
	}
	c := decodeJWT(t, res.Token, []byte(svc.Cfg.SharedSecret))
	if c["iss"] != "acme-mm" || c["aud"] != "opencanvas" || c["role"] != "edit" || c["mode"] != "edit" {
		t.Fatalf("claims %v", c)
	}
	if exp := int64(c["exp"].(float64)); exp != t0.Add(10*time.Minute).Unix() {
		t.Fatalf("exp %d", exp)
	}
	if jti, _ := c["jti"].(string); len(jti) != 32 {
		t.Fatalf("jti %q", jti)
	}
	file := c["file"].(map[string]any)
	if file["id"] != rec.ID || file["name"] != "Sprint notes" || file["context"].(map[string]any)["id"] != "ch1" {
		t.Fatalf("file %v", file)
	}
	user := c["user"].(map[string]any)
	if user["id"] != "alice" || user["name"] != "Alice Doe" || user["detail"] != "@alice" {
		t.Fatalf("user %v", user)
	}
	for _, m := range c["members"].([]any) {
		id := m.(map[string]any)["id"]
		if id == "bot" || id == "gus" || id == "eve" {
			t.Fatalf("member %v must not be listed", id)
		}
	}
	if raw, _ := b64.DecodeString(strings.Split(res.Token, ".")[1]); strings.Contains(string(raw), "@acme") || strings.Contains(string(raw), "email") {
		t.Fatal("token must not carry e-mail")
	}
	uid, err := VerifyCallbackToken(svc.Cfg, c["callbackToken"].(string), rec.ID, t0)
	if err != nil || uid != "alice" {
		t.Fatalf("callback token: %v %q", err, uid)
	}
	// Two launches never share a jti.
	res2, _ := svc.Launch("alice", rec.ID)
	if decodeJWT(t, res2.Token, []byte(svc.Cfg.SharedSecret))["jti"] == c["jti"] {
		t.Fatal("jti reused")
	}
}

func TestCallbackTokenBoundToFileAndExpiry(t *testing.T) {
	cfg := testCfg()
	tok := MintCallbackToken(cfg, "mm_a", "alice", t0)
	if _, err := VerifyCallbackToken(cfg, tok, "mm_b", t0); err == nil {
		t.Fatal("token for another file accepted")
	}
	if _, err := VerifyCallbackToken(cfg, tok, "mm_a", t0.Add(CallbackTokenTTL+time.Second)); err == nil {
		t.Fatal("expired token accepted")
	}
	if _, err := VerifyCallbackToken(cfg, tok[:len(tok)-2]+"AA", "mm_a", t0); err == nil {
		t.Fatal("tampered token accepted")
	}
}

// ---------------------------------------------------------------- membership

func TestMembershipDecidesRole(t *testing.T) {
	svc, _ := newSvc()
	rec := mustCreate(t, svc, "")
	cases := map[string]string{"alice": "edit", "bob": "edit", "gus": "none", "bot": "none", "eve": "none", "ghost": "none"}
	for u, want := range cases {
		if got, _, _ := svc.RoleFor(rec, u); got != want {
			t.Errorf("%s: role %s, want %s", u, got, want)
		}
	}
	svc.Cfg.GuestRole = RoleView
	if got, _, _ := svc.RoleFor(rec, "gus"); got != RoleView {
		t.Errorf("guest role %s", got)
	}
	if _, err := svc.Launch("eve", rec.ID); err != ErrNoAccess {
		t.Fatalf("outsider launch: %v", err)
	}
	if _, err := svc.CreateForUser("eve", "ch1", "x", ""); err != ErrNoAccess {
		t.Fatalf("outsider create: %v", err)
	}
	// Via HTTP, a non-member gets the same 404 as for a missing canvas.
	r := httptest.NewRequest("POST", "/api/v1/canvases/"+rec.ID+"/launch", nil)
	r.Header.Set("Mattermost-User-Id", "eve")
	if w := do(svc, r); w.Code != 404 {
		t.Fatalf("outsider HTTP launch %d", w.Code)
	}
	r = httptest.NewRequest("POST", "/api/v1/canvases/"+rec.ID+"/launch", nil)
	if w := do(svc, r); w.Code != 401 {
		t.Fatalf("anonymous launch %d", w.Code)
	}
}

// ---------------------------------------------------------------- signatures

func TestSignatureReferenceVector(t *testing.T) {
	// Same vector as crates/oc-server/src/host_client.rs signature_v2_binds_method_and_path.
	got := SignV2([]byte("secret"), 1_700_000_000, "PUT", "/api/files/f1?x=1", []byte("{}"))
	if got != "d421c3606ac13be99a16e3c716001ec87107a3ce89c81946403e02371e9c52a7" {
		t.Fatal(got)
	}
}

func TestCallbacksRejectBadSignatures(t *testing.T) {
	svc, _ := newSvc()
	rec := mustCreate(t, svc, "")
	p := "/oc/files/" + rec.ID
	good := signed(svc, "GET", p, nil, t0)
	if w := do(svc, good); w.Code != 404 { // signed and valid: empty canvas
		t.Fatalf("valid signature: %d", w.Code)
	}
	bad := []*http.Request{
		httptest.NewRequest("GET", p, nil),                 // missing
		signed(svc, "GET", p, nil, t0.Add(-6*time.Minute)), // stale
		signed(svc, "GET", p, nil, t0.Add(6*time.Minute)),  // future
		signed(svc, "PUT", p, nil, t0),                     // signed for PUT, sent as GET below
		signed(svc, "GET", "/oc/files/mm_other", nil, t0),  // signed for another file
	}
	bad[3].Method = "GET"
	bad[4].URL.Path = p
	wrongKey := httptest.NewRequest("GET", p, nil)
	wrongKey.Header.Set("X-OpenCanvas-Signature", fmt.Sprintf("t=%d,v2=%s", t0.Unix(),
		SignV2([]byte("not the secret"), t0.Unix(), "GET", "/plugins/"+PluginID+p, nil)))
	v1only := httptest.NewRequest("GET", p, nil)
	v1only.Header.Set("X-OpenCanvas-Signature", fmt.Sprintf("t=%d,v1=%s", t0.Unix(), strings.Repeat("0", 64)))
	bad = append(bad, wrongKey, v1only)
	for i, r := range bad {
		if w := do(svc, r); w.Code != 401 {
			t.Errorf("bad request %d answered %d", i, w.Code)
		}
	}
	// A PUT whose body differs from the signed one is refused and nothing is stored.
	put := signed(svc, "PUT", p, []byte("signed body"), t0)
	put.Body = io.NopCloser(strings.NewReader("other body"))
	if w := do(svc, put); w.Code != 401 {
		t.Fatalf("body swap: %d", w.Code)
	}
	if cur, _, _ := svc.store().Get(rec.ID); cur.Version != 0 {
		t.Fatal("refused PUT changed the file")
	}
}

func TestSignatureUnderSubpath(t *testing.T) {
	svc, _ := newSvc()
	svc.SiteURL = "https://acme.example/chat"
	rec := mustCreate(t, svc, "")
	p := "/oc/files/" + rec.ID
	r := httptest.NewRequest("GET", p, nil)
	ts := t0.Unix()
	r.Header.Set("X-OpenCanvas-Signature", fmt.Sprintf("t=%d,v2=%s", ts,
		SignV2(svc.Cfg.CallbackKey(), ts, "GET", "/chat/plugins/"+PluginID+p, nil)))
	if w := do(svc, r); w.Code != 404 {
		t.Fatalf("subpath signature: %d", w.Code)
	}
	if svc.CallbackBase() != "https://acme.example/chat/plugins/"+PluginID+"/oc" {
		t.Fatal(svc.CallbackBase())
	}
}

// ---------------------------------------------------------------- load / save

func TestLoadSaveConflictIdempotency(t *testing.T) {
	svc, f := newSvc()
	rec := mustCreate(t, svc, "")
	p := "/oc/files/" + rec.ID
	if len(f.posts) != 1 || f.posts[0].ID != rec.ID {
		t.Fatal("card not posted")
	}

	put := func(body, ifMatch, idem string) *httptest.ResponseRecorder {
		r := signed(svc, "PUT", p, []byte(body), t0)
		if ifMatch != "" {
			r.Header.Set("If-Match", `"`+ifMatch+`"`)
		}
		if idem != "" {
			r.Header.Set("Idempotency-Key", idem)
		}
		return do(svc, r)
	}
	w := put("PK-v1", "", "c1")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"version":"1"`) {
		t.Fatalf("first save %d %s", w.Code, w.Body)
	}
	// Retry with the same Idempotency-Key: same answer, no new version.
	if w := put("PK-v1", "", "c1"); !strings.Contains(w.Body.String(), `"version":"1"`) {
		t.Fatalf("retry %s", w.Body)
	}
	w = do(svc, signed(svc, "GET", p, nil, t0))
	if w.Code != 200 || w.Body.String() != "PK-v1" || w.Header().Get("ETag") != `"1"` {
		t.Fatalf("load %d %q %s", w.Code, w.Body, w.Header().Get("ETag"))
	}
	if w := put("PK-v2", "1", "c2"); w.Code != 200 || !strings.Contains(w.Body.String(), `"version":"2"`) {
		t.Fatalf("second save %d %s", w.Code, w.Body)
	}
	// Stale If-Match: 409 with the current version.
	if w := put("PK-stale", "1", "c3"); w.Code != 409 || !strings.Contains(w.Body.String(), `"version":"2"`) {
		t.Fatalf("conflict %d %s", w.Code, w.Body)
	}
	cur, _, _ := svc.store().Get(rec.ID)
	if cur.Version != 2 || len(cur.History) != 1 {
		t.Fatalf("record %+v", cur)
	}
	// Unknown file.
	if w := do(svc, signed(svc, "GET", "/oc/files/mm_nope", nil, t0)); w.Code != 404 {
		t.Fatalf("unknown %d", w.Code)
	}
}

func TestMeetingNotesSeed(t *testing.T) {
	svc, _ := newSvc()
	rec, err := svc.CreateForUser("alice", "ch1", "", "meeting")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(rec.Title, "Meeting notes ") {
		t.Fatal(rec.Title)
	}
	w := do(svc, signed(svc, "GET", "/oc/files/"+rec.ID, nil, t0))
	if w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/markdown") || !strings.Contains(w.Body.String(), "## Action items") {
		t.Fatalf("seed %d %s", w.Code, w.Body)
	}
	if _, err := svc.CreateForUser("alice", "ch1", "x", "nope"); err == nil {
		t.Fatal("unknown template accepted")
	}
}

// ---------------------------------------------------------------- members, access, assets, copies

func TestMembersAndAccess(t *testing.T) {
	svc, _ := newSvc()
	rec := mustCreate(t, svc, "")
	w := do(svc, signed(svc, "GET", "/oc/files/"+rec.ID+"/members?q=bo&limit=10", nil, t0))
	var got []map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if w.Code != 200 || len(got) != 1 || got[0]["id"] != "bob" {
		t.Fatalf("members %d %s", w.Code, w.Body)
	}
	w = do(svc, signed(svc, "GET", "/oc/files/"+rec.ID+"/members", nil, t0))
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if len(got) != 2 { // alice, bob: no guest (guest role none), bot or outsider
		t.Fatalf("members %s", w.Body)
	}
	for u, want := range map[string]string{"bob": "edit", "eve": "none"} {
		body := []byte(`{"fileId":"` + rec.ID + `","userId":"` + u + `"}`)
		w := do(svc, signed(svc, "POST", "/oc/access", body, t0))
		if !strings.Contains(w.Body.String(), `"role":"`+want+`"`) {
			t.Errorf("access %s: %s", u, w.Body)
		}
	}
}

func TestAssetsAreScopedToTheirCanvas(t *testing.T) {
	svc, f := newSvc()
	a := mustCreate(t, svc, "")
	b := mustCreate(t, svc, "")
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "pic.png")
	_, _ = fw.Write([]byte("\x89PNG\r\n\x1a\nxxxx"))
	_ = mw.Close()
	r := signed(svc, "POST", "/oc/files/"+a.ID+"/assets", buf.Bytes(), t0)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	w := do(svc, r)
	var up map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &up)
	if w.Code != 201 || up["mime"] != "application/octet-stream" && up["mime"] != "image/png" {
		t.Fatalf("upload %d %s", w.Code, w.Body)
	}
	id := up["assetId"].(string)
	if !strings.HasPrefix(up["url"].(string), svc.CallbackBase()+"/files/"+a.ID+"/assets/") {
		t.Fatal(up["url"])
	}
	if w := do(svc, signed(svc, "GET", "/oc/files/"+a.ID+"/assets/"+id, nil, t0)); w.Code != 200 {
		t.Fatalf("get asset %d", w.Code)
	}
	if w := do(svc, signed(svc, "GET", "/oc/files/"+b.ID+"/assets/"+id, nil, t0)); w.Code != 404 {
		t.Fatalf("asset read through another canvas: %d", w.Code)
	}
	// An arbitrary Mattermost file id is not an asset.
	f.files["secret"] = []byte("private")
	if w := do(svc, signed(svc, "GET", "/oc/files/"+a.ID+"/assets/a_secret", nil, t0)); w.Code != 404 {
		t.Fatalf("arbitrary file read: %d", w.Code)
	}
	// Signed-in members may read it with their session; outsiders may not.
	for u, want := range map[string]int{"bob": 200, "eve": 404} {
		r := httptest.NewRequest("GET", "/api/v1/canvases/"+a.ID+"/assets/"+id, nil)
		r.Header.Set("Mattermost-User-Id", u)
		if w := do(svc, r); w.Code != want {
			t.Errorf("%s asset via session: %d", u, w.Code)
		}
	}
}

func TestConflictCopy(t *testing.T) {
	svc, f := newSvc()
	rec := mustCreate(t, svc, "")
	w := do(svc, signed(svc, "POST", "/oc/files/"+rec.ID+"/copies", []byte("PK-copy"), t0))
	var res map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if w.Code != 201 || res["fileId"] == "" || res["fileId"] == rec.ID || !strings.HasPrefix(res["url"], "https://chat.acme.example/_redirect/pl/") {
		t.Fatalf("copy %d %s", w.Code, w.Body)
	}
	cp, _, _ := svc.store().Get(res["fileId"])
	if cp.ChannelID != "ch1" || cp.Version != 1 || string(f.files[cp.FileInfoID]) != "PK-copy" || !strings.HasSuffix(cp.Title, "(conflict copy)") {
		t.Fatalf("copy record %+v", cp)
	}
	ids, _ := svc.store().ChannelFiles("ch1")
	if len(ids) != 2 || ids[0] != cp.ID {
		t.Fatalf("channel index %v", ids)
	}
}

func TestLeavingChannelRevokesLive(t *testing.T) {
	var calls []string
	oc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-OpenCanvas-Key") != "k" || r.Header.Get("X-OpenCanvas-Host") != "acme-mm" {
			w.WriteHeader(401)
			return
		}
		b, _ := io.ReadAll(r.Body)
		calls = append(calls, r.URL.Path+" "+string(b))
	}))
	defer oc.Close()
	svc, _ := newSvc()
	svc.OC = &Client{BaseURL: oc.URL, HostID: "acme-mm", APIKey: "k", HTTP: oc.Client()}
	rec := mustCreate(t, svc, "")
	if n := svc.UserLeftChannel("ch1", "bob"); n != 0 {
		t.Fatalf("%d failed", n)
	}
	if len(calls) != 1 || calls[0] != "/v1/files/"+rec.ID+`/role {"role":"none","userId":"bob"}` {
		t.Fatalf("calls %v", calls)
	}
}

func TestConfigValidate(t *testing.T) {
	if _, err := (Config{OpenCanvasURL: "https://x", SharedSecret: "short"}).Validate(); err == nil {
		t.Fatal("short secret accepted")
	}
	if _, err := (Config{OpenCanvasURL: "javascript:x", SharedSecret: strings.Repeat("s", 32)}).Validate(); err == nil {
		t.Fatal("bad URL accepted")
	}
	c, err := Config{OpenCanvasURL: "https://x/", SharedSecret: strings.Repeat("s", 32), TokenTTLMinutes: 999}.Validate()
	if err != nil || c.TokenTTLMinutes != 60 || c.GuestRole != "none" || c.OpenCanvasAPIURL != "https://x" || c.HostID != "mattermost" {
		t.Fatalf("%+v %v", c, err)
	}
	if err != nil || strings.Contains(fmt.Sprint(err), "sss") {
		t.Fatal("error leaks the secret")
	}
}

// Mattermost re-encodes the query before ServeHTTP (it deletes access_token and calls
// url.Values.Encode, which sorts keys): OpenCanvas signs "?q=&limit=500", the plugin sees
// "?limit=500&q=". Seen in a real Mattermost 12.1 run (members callback 401).
func TestSignatureSurvivesQueryReordering(t *testing.T) {
	svc, _ := newSvc()
	rec := mustCreate(t, svc, "")
	p := "/oc/files/" + rec.ID + "/members"
	r := httptest.NewRequest("GET", p+"?limit=500&q=", nil)
	ts := t0.Unix()
	r.Header.Set("X-OpenCanvas-Signature", fmt.Sprintf("t=%d,v2=%s", ts,
		SignV2(svc.Cfg.CallbackKey(), ts, "GET", "/plugins/"+PluginID+p+"?q=&limit=500", nil)))
	if w := do(svc, r); w.Code != 200 {
		t.Fatalf("reordered query: %d", w.Code)
	}
	// A different value is still refused.
	r = httptest.NewRequest("GET", p+"?limit=1&q=", nil)
	r.Header.Set("X-OpenCanvas-Signature", fmt.Sprintf("t=%d,v2=%s", ts,
		SignV2(svc.Cfg.CallbackKey(), ts, "GET", "/plugins/"+PluginID+p+"?q=&limit=500", nil)))
	if w := do(svc, r); w.Code != 401 {
		t.Fatalf("changed query value: %d", w.Code)
	}
}

func TestCallbackTokenHeaderVerifiedWhenPresent(t *testing.T) {
	svc, _ := newSvc()
	a := mustCreate(t, svc, "")
	b := mustCreate(t, svc, "")
	get := func(tok string) int {
		r := signed(svc, "GET", "/oc/files/"+a.ID, nil, t0)
		if tok != "" {
			r.Header.Set("X-OpenCanvas-Callback-Token", tok)
		}
		return do(svc, r).Code
	}
	if c := get(MintCallbackToken(svc.Cfg, a.ID, "alice", t0)); c != 404 { // valid: empty canvas
		t.Fatalf("valid token: %d", c)
	}
	if c := get(""); c != 404 { // older OpenCanvas: signature only
		t.Fatalf("no token: %d", c)
	}
	if c := get(MintCallbackToken(svc.Cfg, b.ID, "alice", t0)); c != 401 {
		t.Fatalf("token for another canvas: %d", c)
	}
	if c := get("oct1.forged.sig"); c != 401 {
		t.Fatalf("forged token: %d", c)
	}
}
