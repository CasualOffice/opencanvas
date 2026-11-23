// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

package canvas

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"
)

// MaxSkew is the docs/05 §5 replay window.
const MaxSkew = 5 * time.Minute

// ErrBadSignature covers every reason a callback signature is refused.
var ErrBadSignature = errors.New("callback signature invalid")

// SignV2 is hex HMAC-SHA256(key, "<ts>.<METHOD>.<path?query>.<body>") (docs/05 §5,
// crates/oc-server/src/host_client.rs signature_header).
func SignV2(key []byte, ts int64, method, pathQuery string, body []byte) string {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(strconv.FormatInt(ts, 10) + "." + method + "." + pathQuery + "."))
	m.Write(body)
	return hex.EncodeToString(m.Sum(nil))
}

// VerifySignature checks an X-OpenCanvas-Signature header ("t=<ts>,v1=<hex>,v2=<hex>").
// Only v2 is accepted: v1 does not bind the method and path. pathQueries lists the paths the
// request may have been signed for (the public callback path; see Service.signedPaths); every
// candidate names this same endpoint, so trying each does not widen what a signature allows.
func VerifySignature(key []byte, header, method string, pathQueries []string, body []byte, now time.Time) error {
	var ts int64 = -1
	var v2 []byte
	for _, part := range strings.Split(header, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch k {
		case "t":
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil {
				return ErrBadSignature
			}
			ts = n
		case "v2":
			b, err := hex.DecodeString(v)
			if err != nil {
				return ErrBadSignature
			}
			v2 = b
		}
	}
	if ts < 0 || len(v2) != sha256.Size {
		return ErrBadSignature
	}
	if d := now.Sub(time.Unix(ts, 0)); d > MaxSkew || d < -MaxSkew {
		return ErrBadSignature
	}
	ok := false
	for _, pq := range pathQueries {
		want, _ := hex.DecodeString(SignV2(key, ts, method, pq, body))
		// Constant time per candidate; all candidates are always tried.
		if hmac.Equal(v2, want) {
			ok = true
		}
	}
	if !ok {
		return ErrBadSignature
	}
	return nil
}
