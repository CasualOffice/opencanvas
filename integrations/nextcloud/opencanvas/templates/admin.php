<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// UNSTYLED PLACEHOLDER (ADR-011): admin settings wait for an approved prototype
// (UI-SCREENS.md "Admin settings"). Values only; the backend is SettingsController.
/** @var array $_ */
$s = $_['settings'];
?>
<div id="opencanvas-admin" class="section">
	<h2>OpenCanvas</h2>
	<p>OpenCanvas URL: <?php p((string)$s['opencanvas_url']); ?></p>
	<p>Internal URL: <?php p((string)$s['opencanvas_internal_url']); ?></p>
	<p>WOPI base (put this in OpenCanvas wopi_allowlist): <?php p((string)$s['wopi_base']); ?></p>
	<p>Public links: <?php p($s['allow_public_links'] ? 'on' : 'off'); ?></p>
	<p>Comment role for read-only shares: <?php p($s['allow_comment_role'] ? 'on' : 'off'); ?></p>
	<p>Change with: occ config:app:set opencanvas opencanvas_url --value=https://canvas.example.com</p>
</div>
