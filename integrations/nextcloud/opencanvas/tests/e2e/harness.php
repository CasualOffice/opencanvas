<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// A stand-in WOPI host for `php -S`, built from the app's framework-free classes (TokenCodec,
// ProofVerifier, PermissionMapper, WopiUtil, StarterFiles) and mirroring WopiController's
// checks, so a real OpenCanvas server can be pointed at it without Nextcloud. Files live in
// $HARNESS_DIR/files/<id>; permissions per user in $HARNESS_DIR/acl.json. Test only.

use OCA\OpenCanvas\Wopi\AccessClaims;
use OCA\OpenCanvas\Wopi\PermissionMapper;
use OCA\OpenCanvas\Wopi\ProofVerifier;
use OCA\OpenCanvas\Wopi\Role;
use OCA\OpenCanvas\Wopi\StarterFiles;
use OCA\OpenCanvas\Wopi\TokenCodec;
use OCA\OpenCanvas\Wopi\WopiUtil;

require __DIR__ . '/../bootstrap.php';

$dir = getenv('HARNESS_DIR');
$self = getenv('HARNESS_SELF');      // e.g. http://localhost:4400
$oc = getenv('HARNESS_OC');          // e.g. http://localhost:8480
$codec = new TokenCodec(str_repeat('harness-secret-', 4));
$log = static fn (string $m) => file_put_contents("$dir/harness.log", $m . "\n", FILE_APPEND);
$json = static function (int $code, array $body = []): void {
	http_response_code($code);
	header('Content-Type: application/json');
	echo json_encode($body);
};
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$acl = json_decode((string)@file_get_contents("$dir/acl.json"), true) ?: [];

// Test helpers: create a starter file, mint a token.
if (preg_match('#^/__test/create/(\d+)/(\w+)$#', $path, $m)) {
	file_put_contents("$dir/files/$m[1]", StarterFiles::bytes($m[2], 'Starter ' . $m[2]));
	file_put_contents("$dir/files/$m[1].name", "Starter $m[2].ocanvas");
	return $json(201);
}
if (preg_match('#^/__test/mint/(\d+)/(\w+)$#', $path, $m)) {
	$t = $codec->encode(new AccessClaims((int)$m[1], $m[2], null, null, null, Role::EDIT, time() + 3600));
	return $json(200, ['token' => $t, 'ttl' => (time() + 3600) * 1000]);
}
if (!preg_match('#^/wopi/files/(\d+)(/contents)?$#', $path, $m)) {
	return $json(404);
}
$id = (int)$m[1];
$contents = isset($m[2]);
$token = (string)($_GET['access_token'] ?? '');

// Proof (with one discovery refresh), exactly like WopiController::authorize.
$url = "$self/wopi/files/$id" . ($contents ? '/contents' : '') . '?access_token=' . rawurlencode($token);
$h = static fn (string $k) => $_SERVER['HTTP_' . strtoupper(str_replace('-', '_', $k))] ?? null;
$why = null;
foreach ([false, true] as $refresh) {
	$cache = "$dir/discovery.xml";
	if ($refresh || !is_file($cache)) {
		file_put_contents($cache, (string)@file_get_contents("$oc/hosting/discovery"));
	}
	$why = ProofVerifier::check(ProofVerifier::keysFromDiscovery((string)file_get_contents($cache)), $token, $url,
		$h('X-WOPI-TimeStamp'), $h('X-WOPI-Proof'), $h('X-WOPI-ProofOld'), time());
	if ($why === null) {
		break;
	}
}
if ($why !== null) {
	$log("proof rejected {$_SERVER['REQUEST_METHOD']} /wopi/files/$id: $why");
	return $json(500);
}
$claims = $codec->decode($token, $id, time());
if ($claims === null) {
	$log("token rejected $id");
	return $json(401);
}
$file = "$dir/files/$id";
if (!is_file($file)) {
	return $json(404);
}
$flags = PermissionMapper::map((int)($acl[$claims->userId] ?? 0), true, true, false, false, $claims->maxRole, false);
if ($flags === null) {
	return $json(404);
}
$name = (string)@file_get_contents("$file.name") ?: "$id.ocanvas";
clearstatcache();
$override = $h('X-WOPI-Override') ?? '';
$method = $_SERVER['REQUEST_METHOD'];

if (!$contents && $method === 'GET') {
	$log("CheckFileInfo $id by {$claims->userId} role {$flags['role']}");
	unset($flags['role']);
	return $json(200, ['BaseFileName' => $name, 'Size' => filesize($file), 'Version' => (string)filemtime($file),
		'LastModifiedTime' => WopiUtil::isoTime(filemtime($file)), 'UserId' => $claims->userId,
		'UserFriendlyName' => ucfirst((string)$claims->userId), 'SupportsLocks' => false] + $flags);
}
if ($contents && $method === 'GET') {
	header('Content-Type: application/octet-stream');
	return print(file_get_contents($file));
}
if ($contents && $method === 'POST') {
	if ($flags['UserCanWrite'] !== true) {
		return $json(401);
	}
	$sent = $h('X-COOL-WOPI-Timestamp');
	if ($sent !== null && $sent !== WopiUtil::isoTime(filemtime($file))) {
		$log("conflict $id: $sent");
		return $json(409, ['COOLStatusCode' => 1010]);
	}
	file_put_contents($file, file_get_contents('php://input'));
	$t = filemtime($file);
	touch($file, $t + 1); // the harness's clock: each save moves mtime forward by a second
	clearstatcache();
	$log("saved $id by {$claims->userId}");
	return $json(200, ['LastModifiedTime' => WopiUtil::isoTime(filemtime($file))]);
}
if (!$contents && $method === 'POST' && $override === 'PUT_RELATIVE') {
	if ($flags['UserCanNotWriteRelative'] === true) {
		return $json(501);
	}
	$new = WopiUtil::relativeName((string)$h('X-WOPI-SuggestedTarget'), $name);
	$newId = $id * 1000 + 1;
	file_put_contents("$dir/files/$newId", file_get_contents('php://input'));
	file_put_contents("$dir/files/$newId.name", (string)$new);
	$log("copied $id -> $newId \"$new\"");
	$t = $codec->encode(new AccessClaims($newId, $claims->userId, null, null, null, $claims->maxRole, time() + 3600));
	return $json(200, ['Name' => $new, 'Url' => "$self/wopi/files/$newId?access_token=$t", 'HostEditUrl' => "$self/f/$newId"]);
}
return $json(501);
