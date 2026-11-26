<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Controller;

use OCA\OpenCanvas\Wopi\ProofVerifier;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\JSONResponse;

/**
 * The WOPI proof check shared by the file and meeting-canvas hosts: refuses anything not signed
 * by OpenCanvas (retrying once with fresh discovery keys after a key rotation).
 * Needs `$this->discovery`, `$this->time`, `$this->logger` and `$this->request`.
 */
trait WopiProof {
	private function proofError(string $url, string $token): ?JSONResponse {
		$why = null;
		foreach ([false, true] as $refresh) {
			$why = ProofVerifier::check(
				$this->discovery->proofKeys($refresh),
				$token,
				$url,
				$this->wopiHeader('X-WOPI-TimeStamp'),
				$this->wopiHeader('X-WOPI-Proof'),
				$this->wopiHeader('X-WOPI-ProofOld'),
				$this->time->getTime(),
			);
			if ($why === null || str_contains($why, 'TimeStamp')) {
				break;
			}
		}
		if ($why === null) {
			return null;
		}
		$this->logger->warning('OpenCanvas WOPI proof rejected: {why}', ['app' => 'opencanvas', 'why' => $why]);
		$this->discovery->markProofFailure();
		return new JSONResponse([], Http::STATUS_INTERNAL_SERVER_ERROR);
	}

	private function wopiHeader(string $name): ?string {
		$v = $this->request->getHeader($name);
		return $v === '' ? null : $v;
	}
}
