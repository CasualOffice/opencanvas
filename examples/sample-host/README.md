# Sample host

A zero-dependency Node app that stands in for your app, or any app that embeds OpenCanvas.
It does the host's half of the contract in [docs/05](../../docs/05-INTEGRATION-GUIDE.md):

- **Owns users and access.** Five demo users (two of them called Asha Rao, on different teams) get a per-file role (edit, comment, view or none). You change roles on the files page.
- **Owns the member list** ([docs/21](../../docs/21-USERS-AND-IDENTITY.md) revision 2). Every user has a `detail` second line. The access table on the files page is the canvas's member list: it goes into the launch token (`members`) and is served at `GET /api/opencanvas/files/:id/members`. Only people with access can be mentioned, everyone sees real names, and no e-mail is ever sent. Reopen the file after a change.
- **Signs launch tokens.** These are HS256 JWTs carrying the file, user, role and permissions. The page form-posts the token into an iframe at `OC_SERVER/v1/launch`.
- **Stores the file.** OpenCanvas saves to `PUT /api/opencanvas/files/:id` and loads from `GET` on the same path. Each save bumps the version. A stale `If-Match` gets a 409.
- **Stores assets.** Assets go to `POST /api/opencanvas/files/:id/assets`.
- **Verifies every callback.** It checks the bearer callback token and the `X-OpenCanvas-Signature` HMAC on each call.

```sh
node server.mjs                     # http://localhost:4000
```

| Env | Default |
|---|---|
| `PORT` | `4000` |
| `OC_SERVER` | `http://localhost:8080` |
| `OC_SECRET` | `dev-secret-change-me` (must match `opencanvas.hosts.toml`) |
| `OC_HOST_ID` | `sample` |
| `DATA_DIR` | `./data` |

To see live collaboration, open a file in one browser as Priya. In a second browser or a private window, pick Asha on the files page and open the same file.
