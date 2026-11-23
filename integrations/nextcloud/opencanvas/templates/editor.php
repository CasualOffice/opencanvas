<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// UNSTYLED PLACEHOLDER (ADR-011): the editor page waits for an approved prototype
// (UI-SCREENS.md "Open view"). It only performs the WOPI launch form POST into an iframe.
/** @var array $_ */
$launch = $_['launch'] ?? [];
if (!isset($launch['action'])) {
	p('This canvas cannot be opened.');
	return;
}
?>
<form id="opencanvas-launch" target="opencanvas-frame" method="post" action="<?php p($launch['action']); ?>">
	<input type="hidden" name="access_token" value="<?php p($launch['access_token']); ?>">
	<input type="hidden" name="access_token_ttl" value="<?php p((string)$launch['access_token_ttl']); ?>">
</form>
<iframe name="opencanvas-frame" title="OpenCanvas" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
<script nonce="<?php p($_['cspNonce'] ?? ''); ?>">document.getElementById('opencanvas-launch').submit();</script>
