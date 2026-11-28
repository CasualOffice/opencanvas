# Dependency update policy

How OpenCanvas takes in, updates and accounts for third-party code (DEP-01). It covers the Rust
workspace (`Cargo.toml`, `Cargo.lock`), the web packages (`web/pnpm-lock.yaml`) and the end-to-end
tests (`e2e/package-lock.json`). Security reports go through [SECURITY.md](../SECURITY.md).

## 1. What is checked

`scripts/audit.sh` is the one gate. It runs:

- `cargo audit` (RustSec advisories) and `cargo deny` with `scripts/deny.toml` (advisories,
  licences, banned crates, allowed sources: crates.io, plus the opencalc git source by name);
- `pnpm audit --prod` for the web packages and `npm audit` for the e2e lockfile;
- `scripts/check-spdx.sh` for our own licence headers.

A new advisory fails it. An advisory we accept is listed in `scripts/deny.toml` with the reason
next to it (today: unmaintained crates with no vulnerability and no maintained replacement in the
crate that pulls them in). An accepted advisory is looked at again on every minor release, and
removed from the list as soon as an update makes it unnecessary.

## 2. When updates happen

| Trigger | What we do | By when |
|---|---|---|
| Advisory affecting code we ship (server, editor, SDK), with a fixed version | Update, run the tests, ship a patch release with a note in the changelog's Security section | Critical or high: within 7 days. Medium or low: the next patch release |
| Advisory with no fixed version | Assess whether the vulnerable path is reachable; if it is, remove or replace the dependency or mitigate it in our code; if not, accept it in `scripts/deny.toml` with the reason | Same as above |
| Advisory in a dev-only or test-only dependency | Update in the next routine pass | Next minor release |
| Routine updates (`cargo update`, `pnpm update` within the ranges in the manifests) | One pass per minor release, on its own branch, before the release candidate | Every minor release |
| Major versions of a dependency | Only when there is a reason (a fix, an advisory, a feature we need, end of support); its own change with its own tests | When needed |
| Rust toolchain and Node | Follow the current stable Rust (the release build uses the `rust` image named in `.github/workflows/release.yml`) and the active Node LTS | Every minor release |

A patch release takes dependency changes only for a security advisory or a bug that affects us.

## 3. How an update lands

1. Lockfiles are committed and every build uses them: `cargo build --locked`, `pnpm install
   --frozen-lockfile`, `npm ci`. An update is a lockfile change in a commit of its own.
2. The full checks run on it: `scripts/prepush.sh`, the Rust and web test suites, the Playwright
   suite, `scripts/audit.sh`, and the initial-JS budget (`scripts/check-budget.mjs`) for web
   packages.
3. The commit message and the changelog name what changed and why (advisory id where there is
   one).

## 4. Adding a dependency

A new dependency needs a reason that our own code would not meet as well, and:

- a licence `scripts/deny.toml` allows (permissive, compatible with Apache-2.0);
- a source on crates.io or npm; a git source only by name in `scripts/deny.toml`, pinned to a
  commit (as opencalc is);
- active maintenance, or a small enough size that we could carry it ourselves;
- for the editor, a look at its size: code not needed for the first screen loads on demand, and
  the initial JS stays inside its budget (`bench/budgets.toml`).

Brand assets and icon sets follow the icons policy: only freely licensed generic icons are
bundled.

## 5. Software bill of materials

Every release has CycloneDX SBOMs attached to its GitHub release, made by
`.github/workflows/release.yml` from the tagged commit:

- `opencanvas-<tag>-rust.cdx.json`: the `opencanvas` server's crates (`cargo cyclonedx`, from
  `Cargo.lock`);
- `opencanvas-<tag>-web.cdx.json`: the web packages' production dependencies (`cdxgen`, from
  `web/pnpm-lock.yaml`);

each with a SHA-256 checksum. They describe the same commit as the container image and the
binaries of that release.
