// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

package canvas

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"
)

// ErrNotFound is returned by a Backend for a missing key, file, user or channel.
var ErrNotFound = errors.New("not found")

// Backend is the slice of Mattermost's plugin API the core needs. The main package implements
// it with plugin.API; tests use an in-memory fake.
type Backend interface {
	// KV store. Get returns (nil, nil) for a missing key.
	KVGet(key string) ([]byte, error)
	KVSet(key string, value []byte, ttl time.Duration) error
	// KVCompareAndSet writes newValue only if the stored value equals oldValue (nil = absent).
	KVCompareAndSet(key string, oldValue, newValue []byte) (bool, error)

	// File store: UploadFile returns the new FileInfo id.
	UploadFile(data []byte, channelID, filename string) (string, error)
	GetFile(fileInfoID string) ([]byte, error)

	User(userID string) (*Person, error)
	IsChannelMember(channelID, userID string) (bool, error)
	ChannelMembers(channelID string) ([]Person, error)
	// CreateCanvasPost posts the custom_opencanvas card and returns the post id.
	CreateCanvasPost(rec *Record, userID string) (string, error)
	// Permalink to a post (for the conflict-copy answer).
	PostURL(postID string) string
}

// Record is one canvas: its index entry in the KV store. The document bytes live in
// Mattermost's file store (FileInfoID); the record never holds content.
type Record struct {
	ID         string `json:"id"`
	ChannelID  string `json:"channelId"`
	Title      string `json:"title"`
	Template   string `json:"template,omitempty"` // "" or "meeting"
	CreatorID  string `json:"creatorId"`
	PostID     string `json:"postId,omitempty"`
	Version    int64  `json:"version"`              // 0 = never saved
	FileInfoID string `json:"fileInfoId,omitempty"` // current .ocanvas in the file store
	// Earlier saves, newest first (kept for version history; capped).
	History   []string `json:"history,omitempty"`
	Size      int      `json:"size,omitempty"`
	CreatedAt int64    `json:"createdAt"`
	UpdatedAt int64    `json:"updatedAt"`
}

// MaxHistory caps Record.History.
const MaxHistory = 50

// VersionString is the ETag value; "" before the first save.
func (r *Record) VersionString() string {
	if r.Version == 0 {
		return ""
	}
	return strconv.FormatInt(r.Version, 10)
}

// KV keys (Mattermost KV keys are at most 150 bytes; ids are 26 characters).
func keyFile(id string) string               { return "f:" + id }
func keyChannel(channelID string) string     { return "c:" + channelID }
func keyAsset(fileID, assetID string) string { return "a:" + fileID + ":" + assetID }
func keyIdem(fileID, idem string) string {
	h := sha256.Sum256([]byte(idem))
	return "i:" + fileID + ":" + hex.EncodeToString(h[:12])
}

// Store wraps a Backend with typed index operations.
type Store struct{ B Backend }

func (s Store) Get(fileID string) (*Record, []byte, error) {
	raw, err := s.B.KVGet(keyFile(fileID))
	if err != nil {
		return nil, nil, err
	}
	if raw == nil {
		return nil, nil, ErrNotFound
	}
	var r Record
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, nil, fmt.Errorf("corrupt record: %w", err)
	}
	return &r, raw, nil
}

// Create stores a new record and adds it to its channel's list.
func (s Store) Create(r *Record) error {
	raw, _ := json.Marshal(r)
	ok, err := s.B.KVCompareAndSet(keyFile(r.ID), nil, raw)
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("file id collision")
	}
	return s.addToChannel(r.ChannelID, r.ID)
}

// Update replaces a record only if it still holds old (optimistic concurrency).
func (s Store) Update(old []byte, r *Record) (bool, error) {
	raw, _ := json.Marshal(r)
	return s.B.KVCompareAndSet(keyFile(r.ID), old, raw)
}

func (s Store) addToChannel(channelID, fileID string) error {
	for i := 0; i < 8; i++ {
		old, err := s.B.KVGet(keyChannel(channelID))
		if err != nil {
			return err
		}
		var ids []string
		if old != nil {
			_ = json.Unmarshal(old, &ids)
		}
		ids = append([]string{fileID}, ids...)
		raw, _ := json.Marshal(ids)
		ok, err := s.B.KVCompareAndSet(keyChannel(channelID), old, raw)
		if err != nil {
			return err
		}
		if ok {
			return nil
		}
	}
	return errors.New("channel index busy")
}

// ChannelFiles lists the canvas ids of a channel, newest first.
func (s Store) ChannelFiles(channelID string) ([]string, error) {
	raw, err := s.B.KVGet(keyChannel(channelID))
	if err != nil || raw == nil {
		return nil, err
	}
	var ids []string
	return ids, json.Unmarshal(raw, &ids)
}

type assetRecord struct {
	FileInfoID string `json:"fileInfoId"`
	Mime       string `json:"mime"`
	Size       int    `json:"size"`
}
