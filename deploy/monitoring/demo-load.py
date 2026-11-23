#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CasualOffice
"""Side traffic for the monitoring quick-start (deploy/monitoring/demo-load.sh), stdlib only.

Every few seconds, against OpenCanvas at --server:
  * exports md, docx and pdf of the bench host's room 0 (pdf answers 501 without Gotenberg);
  * a patch and a commit through the host API for host `broken`, whose saves answer 500
    (oc_host_callbacks_total{host="broken",op="save",result="5xx"}, oc_save_errors_total,
    oc_commit_outbox_pending);
  * launches that are refused (bad signature, garbage token), for oc_launches_rejected_total.
Runs for --secs seconds.
"""
import argparse
import base64
import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request


def b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def jwt(secret, claims):
    head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = b64(json.dumps(claims).encode())
    sig = hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    return f"{head}.{body}.{b64(sig)}"


def claims(host, file_id, user, n):
    now = int(time.time())
    return {"iss": host, "aud": "opencanvas", "iat": now, "exp": now + 3600,
            "jti": f"demo-{host}-{now}-{n}", "file": {"id": file_id, "name": "Demo"},
            "user": {"id": user, "name": user}, "role": "edit", "callback_token": "bench"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


opener = urllib.request.build_opener(NoRedirect)


def call(method, url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with opener.open(req, timeout=30) as r:
            r.read()
            return r.status, dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers)
    except OSError as e:
        return 0, {"error": str(e)}


def launch(server, token):
    return call("POST", f"{server}/v1/launch", data=f"token={token}".encode(),
                headers={"content-type": "application/x-www-form-urlencoded"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default="http://127.0.0.1:8791")
    ap.add_argument("--secret", required=True)
    ap.add_argument("--bench-file", required=True, help="file id of the bench room")
    ap.add_argument("--secs", type=int, default=300)
    a = ap.parse_args()
    end = time.time() + a.secs
    n = 0
    seen = {}
    while time.time() < end:
        n += 1
        st, h = launch(a.server, jwt(a.secret, claims("bench", a.bench_file, f"exporter{n}", n)))
        ticket = h.get("location", h.get("Location", "")).partition("#t=")[2]
        if ticket:
            for fmt in ("md", "docx", "pdf"):
                code, _ = call("GET", f"{a.server}/v1/export/{fmt}?ticket={ticket}")
                seen[f"export {fmt}"] = code
        else:
            seen["launch"] = st
        api = {"X-OpenCanvas-Host": "broken", "X-OpenCanvas-Key": "broken-key",
               "content-type": "application/json"}
        patch = json.dumps({"ops": [{"op": "append", "markdown": f"line {n}"}],
                            "author": {"id": "bot", "name": "Demo bot"}}).encode()
        seen["broken patch"] = call("POST", f"{a.server}/v1/files/broken-doc/patch", patch, api)[0]
        seen["broken commit"] = call("POST", f"{a.server}/v1/files/broken-doc/commit",
                                     headers=api)[0]
        seen["bad signature"] = launch(a.server, jwt("wrong-secret-0123456789abcdef0123",
                                                     claims("bench", "x", "mallory", n)))[0]
        seen["garbage token"] = launch(a.server, "not-a-jwt")[0]
        if n % 6 == 1:
            print(time.strftime("%H:%M:%S"), json.dumps(seen), flush=True)
        time.sleep(5)


if __name__ == "__main__":
    main()
