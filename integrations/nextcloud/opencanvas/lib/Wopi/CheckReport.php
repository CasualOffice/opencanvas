<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Wopi;

/**
 * The admin connection check (UI-SCREENS S12b-S12f) as four steps. A failed step marks the steps
 * after it "skipped". Pure: the controller does the network calls and passes their results in.
 */
final class CheckReport {
	/**
	 * @param string $internalUrl where Nextcloud reached OpenCanvas
	 * @param ?string $xml discovery XML, null when it could not be fetched
	 * @param ?string $fetchError why discovery failed ("timed out after 10 s", …)
	 * @param bool $healthOk OpenCanvas's /healthz answered
	 * @param ?string $version OpenCanvas's version from /healthz
	 * @param ?int $launchStatus HTTP status of the test launch (null: not run)
	 * @param ?string $launchCode its error code (WOPISRC_NOT_ALLOWED, TOKEN_INVALID, …)
	 * @param string $wopiBase what OpenCanvas's wopi_allowlist must contain
	 * @return array{ok: bool, steps: list<array{id: string, status: string, detail?: string, fix?: string}>,
	 *               discovery: bool, ocanvasAction: bool, proofKey: bool, accepts: bool, wopiBase: string}
	 */
	public static function build(
		string $internalUrl,
		?string $xml,
		?string $fetchError,
		bool $healthOk,
		?string $version,
		?int $launchStatus,
		?string $launchCode,
		string $wopiBase,
	): array {
		$host = (string)(parse_url($internalUrl, PHP_URL_HOST) ?? $internalUrl);
		$port = parse_url($internalUrl, PHP_URL_PORT);
		$where = $host . ($port !== null && $port !== false ? ':' . $port : '');

		$discovery = $xml !== null;
		$action = $discovery && str_contains($xml, 'ext="ocanvas"');
		$keys = $discovery ? ProofVerifier::keysFromDiscovery($xml) : ['current' => null];
		$proof = $keys['current'] !== null;
		// The test launch reached CheckFileInfo (which refused the probe token): the WOPISrc is on
		// OpenCanvas's allow-list and OpenCanvas reaches this Nextcloud.
		$accepts = $launchStatus !== null && $launchStatus < 500 && $launchCode !== 'WOPISRC_NOT_ALLOWED';

		$steps = [];
		$steps[] = $discovery
			? ['id' => 'answers', 'status' => 'ok', 'detail' => $where . ($healthOk && $version ? ', OpenCanvas ' . $version : '')]
			: ['id' => 'answers', 'status' => 'fail', 'detail' => 'Nextcloud got no answer from ' . $internalUrl
				. ($fetchError ? ' (' . $fetchError . ')' : '') . '. Check the internal address and that OpenCanvas is running. '
				. 'If Nextcloud and OpenCanvas share a private network, also allow local servers:',
				'fix' => 'occ config:system:set allow_local_remote_servers --value=true --type=boolean'];
		$steps[] = $action
			? ['id' => 'action', 'status' => 'ok']
			: ['id' => 'action', 'status' => 'fail', 'detail' => 'This server answered but doesn\'t offer to open .ocanvas files. '
				. 'Make sure the address points at OpenCanvas (not another WOPI editor such as Collabora) and that it is version 0.1 or later.'];
		$steps[] = $proof
			? ['id' => 'proofKey', 'status' => 'ok', 'detail' => 'Calls from OpenCanvas are verified with this key.']
			: ['id' => 'proofKey', 'status' => 'fail', 'detail' => 'OpenCanvas doesn\'t publish a security (proof) key, so Nextcloud can\'t tell its calls apart from anyone else\'s. Start OpenCanvas with this, then check again:',
				'fix' => 'OC_WOPI_PROOF_KEY=/path/to/proof.pem'];
		if ($accepts) {
			$steps[] = ['id' => 'accepts', 'status' => 'ok'];
		} elseif ($launchCode === 'WOPISRC_NOT_ALLOWED') {
			$steps[] = ['id' => 'accepts', 'status' => 'fail',
				'detail' => 'OpenCanvas refused the test launch (403, WOPISRC_NOT_ALLOWED). Add this line to wopi_allowlist in OpenCanvas\'s opencanvas.hosts.toml and restart it:',
				'fix' => 'wopi_allowlist = ["' . $wopiBase . '"]'];
		} else {
			$steps[] = ['id' => 'accepts', 'status' => 'fail',
				'detail' => 'OpenCanvas couldn\'t reach this Nextcloud at ' . $wopiBase
					. ($launchStatus !== null ? ' (' . $launchStatus . ($launchCode ? ', ' . $launchCode : '') . ')' : '')
					. '. Check that this address is reachable from OpenCanvas, or set a different one below.'];
		}
		$failed = false;
		foreach ($steps as $i => $s) {
			if ($failed) {
				$steps[$i] = ['id' => $s['id'], 'status' => 'skipped', 'detail' => 'Not checked until the step above passes.'];
			} elseif ($s['status'] === 'fail') {
				$failed = true;
			}
		}
		return [
			'ok' => !$failed,
			'steps' => $steps,
			'discovery' => $discovery,
			'ocanvasAction' => $action,
			'proofKey' => $proof,
			'accepts' => $accepts,
			'wopiBase' => $wopiBase,
		];
	}
}
