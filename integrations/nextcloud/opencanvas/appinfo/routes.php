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
