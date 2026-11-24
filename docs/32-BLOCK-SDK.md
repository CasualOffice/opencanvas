# 32 — Block SDK guide: write, package and install a block

**Status:** v0.2 (BSDK-01 to BSDK-05). Contract: docs/15 §4.2-4.3; design: docs/27 §3; decisions:
ADR-040, ADR-058, ADR-059, ADR-060.

A block is a small web component that lives inside a canvas: an OKR tracker, a ticket card, a
chart from your own service. You write it once; OpenCanvas runs it in a sandbox, keeps its data
in the document, collaborates on it in real time and exports it. Nothing about your block runs on
the server.

## 1. How a block runs

- Every block is stored as one `extBlock` node: its `type`, data version `v`, small `attrs` (JSON,
  last writer wins), optional collaborative `data` (one key per field) and a `fallback` copy that
  readers without your block see and export.
- Your bundle runs in an `<iframe sandbox="allow-scripts">` on a separate origin. It cannot see
  the editor's page, its sign-in, its storage or other blocks, cannot open pop-ups or navigate the
  page, and reaches the network only at the origins your manifest asks for and the host allows.
- Everything goes through the context `render` receives. Writes are checked: only people who may
  edit, at most 60 a second, and only values your JSON Schemas accept.
- If your block throws, stops answering for 5 s, or never renders, OpenCanvas shows "This block
  stopped working" with the last saved copy and a Reload button. The rest of the canvas is fine.

## 2. Write it

```ts
import { defineBlock, h } from "@opencanvas/block-sdk";

interface Attrs { label: string; value: number }

defineBlock<Attrs>({
  render(el, ctx) {
    const bar = h("progress", { max: 100 });
    const slider = h("input", { type: "range", min: "0", max: "100" });
    slider.addEventListener("change", () => ctx.setAttrs({ value: Number(slider.value) / 100 }));
    el.append(bar, slider);
    this.update!(ctx);
  },
  update(ctx) {
    // Attrs, data, role or theme changed: redraw from ctx.
  },
});
```

The context (`BlockContext`):

| member | what it does |
|---|---|
| `attrs`, `data.get/all` | read the current values (copies) |
| `setAttrs(patch)`, `data.set(fields)` | write; `null` removes a key; rejects with the reason when refused |
| `data.observe(fn)` | called after any data change, yours or someone else's |
| `role`, `readOnly` | hide your controls when `readOnly` (viewers, commenters) |
| `theme` | `{scheme, tokens}`; tokens are also CSS properties `--oc-fg`, `--oc-accent`, … on your root |
| `resize(h)` | the frame follows your content's height by itself; force one if you need to |
| `openLink(url)` | ask the editor to open a link |
| `members.list()` | names and pictures of the canvas's people (with `members: "read"`); never e-mail |
| `permissions` | what you may do on this host (network origins, members) |

Keyboard: Escape and Tab past your first or last control return focus to the editor. Draw your
own focus styles; the editor draws a ring around the frame.

Test it without a browser frame:

```ts
import { createHarness } from "@opencanvas/block-sdk/harness";
const t = createHarness(myBlock, { attrs: { label: "Launch", value: 0.2 }, role: "edit" });
t.el.querySelector("input")!.dispatchEvent(new Event("change"));
expect(t.attrs().value).toBe(0.2);
```

## 3. Describe it: `block.json`

```jsonc
{
  "type": "acme.okr",                // lowercase reverse-DNS; "oc." is OpenCanvas's
  "version": "1.2.0",                // SemVer of your data contract; v = the major
  "title": "OKR",
  "icon": "target",                  // any Lucide icon name
  "publisher": "Acme Corp",
  "description": "Objective and key results",
  "keywords": ["goals"],
  "discovery": { "label": "OKR", "category": "data-planning", "keywords": ["okr"],
                 "profiles": ["project", "meeting", "full"], "complexity": "basic" },
  "content": "none",                 // "none" | "inline" | "blocks" (editable children below)
  "attrs": { "type": "object", "properties": { "objective": { "type": "string", "default": "New objective" } },
             "required": ["objective"] },
  "data": { "kind": "map", "schema": { "type": "object" } },
  "export": { "markdown": "**{{objective}}** ({{progress|percent}})", "text": "{{objective}}" },
  "permissions": { "network": ["https://okr.acme.example"], "members": "read" },
  "migrations": { "1": [{ "op": "move", "from": "/attrs/name", "path": "/attrs/objective" }] },
  "preview": "preview.png",          // optional gallery card image
  "entry": "block.js",
  "integrity": "sha384-…"            // of block.js (Subresource Integrity)
}
```

- **Schemas** are JSON Schema 2020-12, the subset in docs/15 §4.2. Give required properties a
  `default`: a newly inserted block starts from them.
- **Export templates** are logic-less (`{{name}}`, sections, the fixed filters `percent number
  date upper lower trim truncate default join count yesno`). Markdown, HTML, Word, PDF, previews
  and agents read your block through them; without one, through your fallback.
- **Discovery** files the block in the / menu and the gallery: `category` is one of `content`,
  `data-planning`, `visual`, `layout`, `extensions`; `profiles` the editor profiles that offer
  it (`notebook`, `meeting`, `project`, `diagramming`, `document`, `full`); `complexity` `basic`
  or `advanced`. Unknown names refuse the package.
- **Versions.** A breaking change is a new major with a migration for every step: declarative
  steps (`set default remove move copy map scale`, run by the server and the editor) or a script
  (`"migrations": "migrations.js"` calling `defineMigrations({1: (attrs, data) => ({attrs, data})})`,
  run in your frame). Older data opens migrated and is saved at the new version on the first edit.
  Data from a newer version than the installed one is shown read only, untouched.

## 4. Build and package

Bundle your block into one script (any bundler; `@opencanvas/block-sdk` has no runtime
dependencies), then write its hash into the manifest:

```sh
esbuild src/main.ts --bundle --format=iife --minify --outfile=block.js
echo "sha384-$(openssl dgst -sha384 -binary block.js | base64)"
```

The samples show the whole flow: `web/packages/block-sdk/samples/{progress,okr}` built by
`node web/packages/block-sdk/scripts/build-samples.mjs` into `crates/oc-server/blocks/oc.progress`
(OpenCanvas's own block, compiled into the server) and `examples/blocks/acme.okr` (a third-party
package with a `preview.png`).

## 5. Install and enable (operators)

1. Put each package in its own directory under `OC_BLOCKS_DIR` (`block.json`, `block.js`, and
   any `migrations.js` / `preview.png`). The server checks every manifest and hash at start-up;
   a package that fails is refused, logged and listed on `/healthz`, and the server still starts.
2. Set `OC_BLOCKS_ORIGIN` to a second host name of the server (`https://blocks.canvas.example`)
   and `OC_PUBLIC_URL` to the editor's. Block code runs only on the block origin.
3. Enable per host, and narrow permissions if you like (docs/05 §2a):

```toml
[host.blocks]
enabled = ["oc.progress", "acme.okr@^1"]
[host.blocks.permissions."acme.okr"]
members = "none"
```

People then find the blocks in the / menu under "From your organisation" and in Browse all
blocks. A canvas opened where a block is not available shows its saved copy, read only, and
keeps all its data.
