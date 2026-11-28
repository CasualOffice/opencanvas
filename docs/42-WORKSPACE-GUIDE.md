# 42 — OpenCanvas Workspace guide

OpenCanvas Workspace, by CasualOffice, is a self-hosted workspace for documents, spreadsheets,
whiteboards and databases, in one container. It is the OpenCanvas engine with everything around it
that a team needs: accounts, files, sharing, search, trash, history and an admin area. This guide is
for the people who run it and the admins who set it up. The design and the reasons behind it are in
[docs/40](40-WORKSPACE.md) and ADR-085.

## 1. Install

You need Docker on a Linux, macOS or Windows machine (linux/amd64 or linux/arm64 images).

```sh
docker run -p 8080:8080 -v opencanvas:/data ghcr.io/casualoffice/opencanvas-workspace
```

- `-p 8080:8080` publishes the one port the Workspace uses.
- `-v opencanvas:/data` keeps everything in a named volume: the databases, the files, the backups
  and the generated secrets. **Without a volume your data is lost when the container is removed**;
  the log says so loudly when no volume is mounted.
- To pin a release, use the version as the tag, for example
  `ghcr.io/casualoffice/opencanvas-workspace:0.5.0`. `latest` follows the newest final release.

The container runs as an unprivileged user (uid 10001), answers `GET /api/ws/healthz` for health
checks, and stops cleanly on `SIGTERM` after saving open files.

For a public address, put it behind a TLS reverse proxy and tell it the address:

```sh
docker run -d --name opencanvas --restart unless-stopped \
  -p 8080:8080 -v opencanvas:/data \
  -e WS_PUBLIC_URL=https://canvas.example.com \
  -e WS_TRUST_PROXY=1 \
  ghcr.io/casualoffice/opencanvas-workspace
```

The proxy must pass WebSocket upgrades (the editor's live connection) and keep the `Host` header.
[`deploy/workspace/nginx.conf`](../deploy/workspace/nginx.conf) is a working example.

### Production with compose

[`deploy/workspace/compose.yml`](../deploy/workspace/compose.yml) runs the same image three times,
as one Workspace (`--role workspace`) and two engine nodes (`--role engine`, cluster mode with
Redis), with MariaDB for both databases and nginx in front on one port:

```sh
cp deploy/workspace/.env.example deploy/workspace/.env   # fill in real secrets
docker compose -f deploy/workspace/compose.yml --env-file deploy/workspace/.env up -d
```

`.env.example` says how to generate each secret. Keep `.env` with your backups: without the
secrets in it, saved sessions and the engine's write-ahead log cannot be read.

## 2. First run and the setup code

On first start the log prints the address and a one-time **setup code** of six words, in a line
like this:

```
WARN first run: open the URL and enter the setup code (not needed from the same machine)
     url=http://localhost:8080 setup_code=maple orbit lantern seven quiet harbor
```

Read it with `docker logs opencanvas`. Opening the address from the same machine (loopback) skips
the code, so a laptop trial needs no log reading. Anyone else must type the code, in order; case and
separators do not matter.

Setup asks for:

1. the organisation's name;
2. the first admin (the Owner): name, e-mail and a password of at least 10 characters, or a
   passkey straight away;
3. the public address, filled in from your browser; it is used in links and for passkeys;
4. the first workspace's name, and whether to add a *Welcome* workspace with sample files (on by
   default).

Setup ends on Home with a checklist: invite people, choose sign-in methods, set up e-mail and set up
backups. The setup code stops working once setup is done.

## 3. Invite people

Admins invite from **Admin › Members** (*Invite people*), and anyone who can share a file can
invite by e-mail address from its Share dialog. An invite is to the organisation (as a Member or a Guest),
to a workspace, or to one file.

Every invite is a **single-use link that is valid for 7 days**. E-mail is not sent yet, so copy the
link and send it yourself (chat, your own e-mail). The person who opens it sees who invited them and
to what, and signs up with a password or with a passkey only.

- **Members** see the organisation's open workspaces and can be added to anything.
- **Guests** see only what is shared with them and cannot browse the member list.
- Open sign-up is off. Admins can suspend people, change their role, and create a password reset
  link for someone who is locked out.

If every admin is locked out, the operator can make a reset link from the command line:

```sh
docker exec -it opencanvas opencanvas-workspace admin reset-password owner@example.com
```

## 4. Passkeys

A passkey signs you in with your device (Touch ID, Windows Hello, a phone, a security key) instead
of a password. Add one on the **You** page, under **Passkeys**; you can add several and name them. On the sign-in
page, *Sign in with a passkey* (or the browser's autofill) uses it. You cannot remove your last way
of signing in.

Passkeys are bound to the public address. Browsers allow them only over HTTPS or on `localhost`,
so set `WS_PUBLIC_URL` to the real `https://` address before people register passkeys; passkeys
made for one address do not work on another.

## 5. Files and sharing

*New* creates one of four file types, each with its own icon in Home, search and trash:

| Type | Opens as |
|---|---|
| Document | The canvas editor: text, tables, images, and any block (a sheet, a board, a database) inside |
| Spreadsheet | The full-screen spreadsheet: grid, formula bar, sheet tabs |
| Whiteboard / Diagram | The full-screen board: pen, sticky notes, shapes, connectors |
| Database | The database on its views: table, board, calendar, gallery, Timeline |

Files live in a workspace, in folders, or in *My canvases*, your private space. Star a file to keep it
in Favourites. Everything saves automatically; there is no Save button.

**Share** opens the share dialog:

- Add people, teams or e-mail addresses (an address without an account becomes an invite link).
- Roles: **Full access** (also share, move and delete), **Can edit**, **Can comment**, **Can view**.
- Access inherited from a workspace or folder is shown with where it comes from, and is changed
  there.
- **General access**: only people added, everyone in the organisation, or anyone with the link.

Removing someone's access takes effect at once: if they have the file open, their session ends.
People without access get "not found", so a title never leaks.

## 6. Public links

"Anyone with the link" lets people without an account open a file. Admins decide in **Admin ›
Settings › Sharing and links** whether public links are allowed at all and the highest role they
may grant (view, comment or edit). Each link can have an **expiry** and a **password**. Turning
public links off disables every existing one.

The operator can fix this policy with `WS_PUBLIC_LINKS=off` (or `on`) and
`WS_PUBLIC_LINK_MAX_ROLE=view`; the setting then shows as "Set by the operator" in the app.

## 7. Search, trash and history

- **Search** (⌘K) finds files by title and by their text; filter by type and workspace. Results only ever include files you can open.
- **Trash** keeps deleted files and folders (with what was in them) for 30 days by default (1 to 365
  in **Settings › Storage and retention**). Restore puts them back where they were.
- **Version history** keeps every save for 24 hours, then one an hour for 7 days and one a day for
  90 days; named versions are kept forever. Restoring makes a new version.

## 8. Backups

Backups are **manual** in this release. Two ways:

1. **Admin › Settings › Backups › Back up now** writes a consistent copy of the SQLite database and
   the files into `/data/backups/<time>`. Copy that folder off the machine.
2. Stop the container and copy the whole volume:

   ```sh
   docker stop opencanvas
   docker run --rm -v opencanvas:/data -v "$PWD":/backup debian:bookworm-slim \
     tar -czf /backup/opencanvas-$(date +%F).tar.gz -C /data .
   docker start opencanvas
   ```

Either way, keep **`/data/secrets/`** with the backup and keep it private: it holds the generated
keys, and without them saved sessions and the engine's log cannot be read.

To restore, stop the container, empty the volume, unpack the archive into it and start the same or
a newer image. With compose and MariaDB, back up both databases with `mariadb-dump` and the
`workspace-data` volume, plus your `.env`.

Not there yet: a backup schedule, a single-file archive with encrypted secrets, and a
`restore` command (tracker WS-20).

## 9. Upgrade

1. Back up (section 8).
2. Pull and restart with the new version:

   ```sh
   docker pull ghcr.io/casualoffice/opencanvas-workspace:<version>
   docker stop opencanvas && docker rm opencanvas
   docker run -d --name opencanvas ... ghcr.io/casualoffice/opencanvas-workspace:<version>
   ```

Database migrations run on start. An older image refuses to start on a database that a newer one
has upgraded, with a message saying so: to go back, restore the backup you took before upgrading.
The Workspace's version number is the engine release it ships with.

## 10. Configuration

Most settings live in the app (**Admin › Settings**). These environment variables are for the
operator; a value set here shows in the app as "Set by the operator" and cannot be changed there.

| Variable | Default | What it does |
|---|---|---|
| `WS_PUBLIC_URL` | chosen at setup | The public address (`https://…`), used in links, passkeys and allowed origins. Setting it avoids a restart when the address changes. |
| `WS_BIND` | `0.0.0.0:8080` | Address and port to listen on. |
| `WS_DATA_DIR` | `/data` in the image | Where the databases, files, backups and secrets live. |
| `WS_DATABASE_URL` | SQLite in `WS_DATA_DIR` | `sqlite://…` or `mysql://…` (MySQL 8 or MariaDB 10.6+) for the Workspace's own data. |
| `DATABASE_URL` | SQLite `engine.db` in `WS_DATA_DIR` | The engine's database (live-session log and save outbox), as for the engine image. |
| `WS_TRUST_PROXY` | off | `1` when a reverse proxy is in front: the client address for rate limits is read from `X-Forwarded-For`. |
| `WS_SECURE_COOKIES` | on when the public URL is `https` | `0` for plain-HTTP trials on another machine. |
| `WS_PUBLIC_LINKS` | in the app | `on` or `off`: whether public links may exist. |
| `WS_PUBLIC_LINK_MAX_ROLE` | in the app | `view`, `comment` or `edit`: the highest role a public link may grant. |
| `WS_EXTRA_ORIGINS` | none | More allowed origins, comma separated (for example a second address of the same server). |
| `WS_BREACHED_LIST` | bundled list | A file with one leaked password per line, refused at sign-up and password change, in addition to the bundled list. |
| `WS_LOG` | `info` | Log level (`error`, `warn`, `info`, `debug`). |
| `WS_ROLE` | `all` | `all`, `workspace` or `engine` (same as `--role`); compose runs the halves separately. |
| `WS_ENGINE_URL` | loopback | Where the Workspace reaches the engine (compose: the engine nodes behind nginx). |
| `WS_CALLBACK_BASE` | loopback | Where the engine reaches the Workspace's callbacks (compose: `http://workspace:8080/api/ws/oc`). |
| `WS_HOST_ID` | `workspace` | The host id the Workspace registers with the engine. |
| `WS_HOST_SECRET`, `WS_HOST_API_KEY`, `WS_TOKEN_KEY`, `OC_KEK` | generated into `/data/secrets` | Secrets. Generated on first start (files with mode 0600); set them only when several containers must share them, as in compose. |
| `WS_WEB_DIR`, `OC_WEB_DIR` | set in the image | Where the web apps are; leave as they are. |

The engine's own `OC_*` settings (AI and MCP, export with Gotenberg, room limits, metrics) apply as
described in the [operations guide](13-OPERATIONS-AND-DEPLOYMENT.md).

## 11. Current limits

- **No single sign-on yet.** OIDC SSO is on the backlog (WS-07); sign-in is passwords, passkeys and
  invite links.
- **E-mail is not sent yet.** SMTP settings can be saved, but invites, mentions and password resets
  are links you copy (WS-08).
- **Backups are manual** (section 8); no schedule, encrypted archive or restore command yet (WS-20).
- **Files are stored on the volume.** S3-compatible storage is not there yet (WS-11).
- **No presence or thumbnails on file cards yet** (WS-12).
- One organisation per deployment. Support is best effort, with no production SLA.

Every item is a row in the [execution tracker](10-EXECUTION-TRACKER.md).
