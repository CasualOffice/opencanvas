# OpenCanvas v0.1.2 release notes

OpenCanvas 0.1.2 adds host integrations, structured diagramming, version history, and a
versioned headless API. See the [changelog](../CHANGELOG.md) for changes since v0.1.1
and the [execution tracker](10-EXECUTION-TRACKER.md) for implementation and test evidence.

## What's included

- The [Nextcloud app](../integrations/nextcloud/README.md) uses WOPI and keeps canvas files,
  versions, and shares in Nextcloud. The [Mattermost plugin](../integrations/mattermost/README.md)
  adds canvases to channels. The [Element / Matrix widget](../integrations/matrix/README.md)
  provides shared room canvases. [Jitsi Meet](../integrations/jitsi/README.md) continues to
  support temporary meeting canvases.
- [Diagram mode](29-DIAGRAMMING.md) adds libraries, ports, routing, and auto-layout.
  Import draw.io and Excalidraw with a dry-run report, and export draw.io and Mermaid alongside
  PNG and SVG. See the diagram guide for format coverage and mixed-version behavior.
- [Version history](30-VERSION-HISTORY.md) supports named saves, comparison, restore, and a
  30-second undo after restore. The history menu depends on host capabilities and user permissions.
- The [host integration guide](05-INTEGRATION-GUIDE.md) describes the headless API, scoped access,
  and host launch options. Read the [operations guide](13-OPERATIONS-AND-DEPLOYMENT.md) for deployment
  and monitoring.

## Upgrade notes

- Back up host files and follow the [recovery guidance](25-RELEASE-v0.1.0-alpha.1.md#durability-modes)
  before upgrading. Allow active saves to complete before replacing the server.
- Use `ghcr.io/casualoffice/opencanvas:0.1.2` for the container. For Helm, use chart `0.1.2`
  from the checkout with `image.repository=ghcr.io/casualoffice/opencanvas`. WOPI hosts still
  need proof keys. Consult the [v0.1.0 upgrade notes](28-RELEASE-v0.1.0.md#upgrade-notes) for older deployments.
- Configure each integration with its own guide, including the allowed iframe origins. Hosts adopting
  version history should check their callback support and the permissions granted to each user.

## Known limitations

Support is best-effort, with no production SLA. Start with a single node and review the
[capacity guidance](22-CAPACITY-AND-SIZING.md) before scaling. AI and MCP are experimental and
off by default. For diagram interchange and mixed-version sessions, see the
[diagram guide](29-DIAGRAMMING.md).
