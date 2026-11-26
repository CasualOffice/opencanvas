<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// WOPISrc = {base}/index.php/apps/opencanvas/wopi/files/{fileId}; OpenCanvas's
// wopi_allowlist entry is {base}/index.php/apps/opencanvas/wopi (README.md).
return [
	'routes' => [
		['name' => 'wopi#checkFileInfo', 'url' => '/wopi/files/{fileId}', 'verb' => 'GET', 'requirements' => ['fileId' => '\d+']],
		['name' => 'wopi#postFile', 'url' => '/wopi/files/{fileId}', 'verb' => 'POST', 'requirements' => ['fileId' => '\d+']],
		['name' => 'wopi#getFile', 'url' => '/wopi/files/{fileId}/contents', 'verb' => 'GET', 'requirements' => ['fileId' => '\d+']],
		['name' => 'wopi#putFile', 'url' => '/wopi/files/{fileId}/contents', 'verb' => 'POST', 'requirements' => ['fileId' => '\d+']],
		['name' => 'wopi#versions', 'url' => '/wopi/files/{fileId}/versions', 'verb' => 'GET', 'requirements' => ['fileId' => '\d+']],
		['name' => 'wopi#versionContents', 'url' => '/wopi/files/{fileId}/versions/{version}/contents', 'verb' => 'GET', 'requirements' => ['fileId' => '\d+', 'version' => '\d+']],

		// TALK-01 meeting canvases: same /wopi prefix (allow list), token file id = -meetingId.
		['name' => 'meeting_wopi#checkFileInfo', 'url' => '/wopi/meetings/{meetingId}', 'verb' => 'GET', 'requirements' => ['meetingId' => '\d+']],
		['name' => 'meeting_wopi#getFile', 'url' => '/wopi/meetings/{meetingId}/contents', 'verb' => 'GET', 'requirements' => ['meetingId' => '\d+']],
		['name' => 'meeting_wopi#putFile', 'url' => '/wopi/meetings/{meetingId}/contents', 'verb' => 'POST', 'requirements' => ['meetingId' => '\d+']],

		// TALK-01 Canvas panel in Talk.
		['name' => 'talk#state', 'url' => '/talk/{room}/state', 'verb' => 'GET'],
		['name' => 'talk#start', 'url' => '/talk/{room}/meeting', 'verb' => 'POST'],
		['name' => 'talk#launch', 'url' => '/talk/{room}/meeting/{id}/launch', 'verb' => 'POST', 'requirements' => ['id' => '\d+']],
		['name' => 'talk#decide', 'url' => '/talk/{room}/meeting/{id}/decide', 'verb' => 'POST', 'requirements' => ['id' => '\d+']],
		['name' => 'talk#options', 'url' => '/talk/{room}/meeting/{id}/options', 'verb' => 'POST', 'requirements' => ['id' => '\d+']],
		['name' => 'talk#settings', 'url' => '/talk/{room}/settings', 'verb' => 'POST'],
		['name' => 'talk#follow', 'url' => '/talk/{room}/follow', 'verb' => 'POST'],
		['name' => 'talk#followView', 'url' => '/talk/{room}/follow/view', 'verb' => 'POST'],
		['name' => 'talk#access', 'url' => '/talk/{room}/access/{fileId}', 'verb' => 'GET', 'requirements' => ['fileId' => '\d+']],
		['name' => 'talk#share', 'url' => '/talk/{room}/share/{fileId}', 'verb' => 'POST', 'requirements' => ['fileId' => '\d+']],

		['name' => 'launch#open', 'url' => '/open/{fileId}', 'verb' => 'GET', 'requirements' => ['fileId' => '\d+']],
		['name' => 'launch#token', 'url' => '/api/v1/token/{fileId}', 'verb' => 'POST', 'requirements' => ['fileId' => '\d+']],
		['name' => 'launch#publicInfo', 'url' => '/api/v1/share/{shareToken}/info', 'verb' => 'GET'],
		['name' => 'launch#diagnose', 'url' => '/api/v1/diagnose', 'verb' => 'GET'],
		['name' => 'launch#publicToken', 'url' => '/api/v1/share/{shareToken}/token/{fileId}', 'verb' => 'POST', 'requirements' => ['fileId' => '\d+']],
		['name' => 'launch#create', 'url' => '/api/v1/create', 'verb' => 'POST'],

		['name' => 'settings#get', 'url' => '/settings/admin', 'verb' => 'GET'],
		['name' => 'settings#set', 'url' => '/settings/admin', 'verb' => 'POST'],
		['name' => 'settings#check', 'url' => '/settings/check', 'verb' => 'POST'],
		['name' => 'settings#rotateSecret', 'url' => '/settings/rotate-secret', 'verb' => 'POST'],
	],
];
