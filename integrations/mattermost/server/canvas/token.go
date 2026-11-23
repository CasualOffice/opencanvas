// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

package canvas

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Person is a Mattermost user as OpenCanvas sees it (docs/21): never an e-mail address.
type Person struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Detail string `json:"detail,omitempty"`
	Avatar string `json:"avatar,omitempty"`
	// Not sent to OpenCanvas.
	Guest   bool `json:"-"`
	Bot     bool `json:"-"`
	Deleted bool `json:"-"`
}

// LaunchInput is what a launch token is minted from.
type LaunchInput struct {
	File    *Record
	User    Person
	Role    string
	Members []Person // optional; at most MaxTokenMembers are sent
}

// MaxTokenMembers is the docs/05 §3 limit on the members claim.
const MaxTokenMembers = 500

// CallbackTokenTTL bounds how long OpenCanvas may use a callback token. OpenCanvas keeps it
// for the session (≤ 10 h) and retries saves from its outbox, so it outlives the launch.
const CallbackTokenTTL = 24 * time.Hour

type fileClaim struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Version string            `json:"version,omitempty"`
	Context map[string]string `json:"context,omitempty"`
}

type perms struct {
	Export        bool `json:"export"`
	Download      bool `json:"download"`
	Print         bool `json:"print"`
	CommitMessage bool `json:"commitMessage"`
	Mention       bool `json:"mention"`
}

// LaunchClaims is the docs/05 §3 token body.
type LaunchClaims struct {
	Iss           string    `json:"iss"`
	Aud           string    `json:"aud"`
	Iat           int64     `json:"iat"`
	Nbf           int64     `json:"nbf"`
	Exp           int64     `json:"exp"`
	Jti           string    `json:"jti"`
	File          fileClaim `json:"file"`
	User          Person    `json:"user"`
	Members       []Person  `json:"members,omitempty"`
	Role          string    `json:"role"`
	Perms         perms     `json:"perms"`
	Mode          string    `json:"mode"`
	CallbackToken string    `json:"callbackToken"`
}

var b64 = base64.RawURLEncoding

// MintLaunch signs an HS256 launch token. The caller has already checked that the user may
// open the file with role (never RoleNone).
func MintLaunch(cfg Config, in LaunchInput, now time.Time) (string, *LaunchClaims, error) {
	if in.Role == RoleNone || in.Role == "" {
		return "", nil, errors.New("no access")
	}
	jti, err := randomHex(16)
	if err != nil {
		return "", nil, err
	}
	members := in.Members
	if len(members) > MaxTokenMembers {
		members = nil // the members callback serves large channels
	}
	mode := RoleEdit
	if in.Role == RoleView {
		mode = RoleView
	}
	c := &LaunchClaims{
		Iss: cfg.HostID,
		Aud: "opencanvas",
		Iat: now.Unix(),
		Nbf: now.Unix() - 5,
		Exp: now.Add(cfg.TokenTTL()).Unix(),
		Jti: jti,
		File: fileClaim{
			ID:      in.File.ID,
			Name:    in.File.Title,
			Version: in.File.VersionString(),
			Context: map[string]string{"type": "channel", "id": in.File.ChannelID},
		},
		User:          in.User,
		Members:       members,
		Role:          in.Role,
		Perms:         perms{Export: true, Download: true, Print: true, CommitMessage: in.Role == RoleEdit, Mention: in.Role != RoleView},
		Mode:          mode,
		CallbackToken: MintCallbackToken(cfg, in.File.ID, in.User.ID, now),
	}
	tok, err := signHS256([]byte(cfg.SharedSecret), c)
	return tok, c, err
}

func signHS256(key []byte, claims any) (string, error) {
	header := b64.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	body, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	input := header + "." + b64.EncodeToString(body)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(input))
	return input + "." + b64.EncodeToString(mac.Sum(nil)), nil
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// The callback token is opaque to OpenCanvas, which sends it back as a bearer on every
// callback. Ours is self-contained: "oct1.<b64 json {f,u,e}>.<b64 hmac>", keyed by a key
// derived from the shared secret so it can never be confused with a launch token.
type callbackClaims struct {
	F string `json:"f"`
	U string `json:"u"`
	E int64  `json:"e"`
}

func callbackKey(cfg Config) []byte {
	m := hmac.New(sha256.New, []byte(cfg.SharedSecret))
	m.Write([]byte("opencanvas-mattermost callback token v1"))
	return m.Sum(nil)
}

// MintCallbackToken binds a token to one file and one user.
func MintCallbackToken(cfg Config, fileID, userID string, now time.Time) string {
	body, _ := json.Marshal(callbackClaims{F: fileID, U: userID, E: now.Add(CallbackTokenTTL).Unix()})
	p := "oct1." + b64.EncodeToString(body)
	m := hmac.New(sha256.New, callbackKey(cfg))
	m.Write([]byte(p))
	return p + "." + b64.EncodeToString(m.Sum(nil))
}

// ErrBadCallbackToken covers every reason a bearer is refused; the reason is not disclosed.
var ErrBadCallbackToken = errors.New("callback token invalid")

// VerifyCallbackToken returns the user the token was minted for, if it is valid for fileID.
func VerifyCallbackToken(cfg Config, tok, fileID string, now time.Time) (string, error) {
	i := strings.LastIndexByte(tok, '.')
	if !strings.HasPrefix(tok, "oct1.") || i <= len("oct1.") {
		return "", ErrBadCallbackToken
	}
	sig, err := b64.DecodeString(tok[i+1:])
	if err != nil {
		return "", ErrBadCallbackToken
	}
	m := hmac.New(sha256.New, callbackKey(cfg))
	m.Write([]byte(tok[:i]))
	if !hmac.Equal(sig, m.Sum(nil)) {
		return "", ErrBadCallbackToken
	}
	raw, err := b64.DecodeString(tok[len("oct1."):i])
	if err != nil {
		return "", ErrBadCallbackToken
	}
	var c callbackClaims
	if json.Unmarshal(raw, &c) != nil || c.F != fileID || c.U == "" || now.Unix() > c.E {
		return "", ErrBadCallbackToken
	}
	return c.U, nil
}
