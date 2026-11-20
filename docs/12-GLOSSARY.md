# 12 — Glossary

| Term | Meaning |
|---|---|
| **Host** | The integrating application. Owns users, ACL, files, versions. |
| **Canvas** | One collaborative document: blocks + boards + comments. |
| **Block** | A unit of content with a stable id (paragraph, table, image, board…). |
| **Board** | A whiteboard surface embedded as a block. |
| **Room** | The live, in-memory collaboration session for one (host, file). |
| **Owner node** | The single cluster node holding a room's authoritative Doc. |
| **Launch token** | Host-signed JWT stating file, user, role, perms. |
| **Session ticket** | Short-lived, single-room credential for the WebSocket. |
| **Grant** | Verified result of a launch: {host, file, user, role, perms, exp}. |
| **Commit** | Serialising the room to `.ocanvas` and saving it to the host (autosave or manual with message). |
| **WAL** | `room_updates` + `room_snapshots`: transient log so no acked edit is lost before commit. |
| **Awareness** | Ephemeral presence state (cursor, pointer, name, colour). |
| **`.ocanvas`** | Native zip file format (manifest, document.json, ydoc.bin). |
| **WOPI** | Web Application Open Platform Interface — the Collabora/Office host protocol. |
| **CRDT** | Conflict-free replicated data type (Yjs here). |
| **Unfurl** | Fetching a link's title/description/image to render a link card. |
