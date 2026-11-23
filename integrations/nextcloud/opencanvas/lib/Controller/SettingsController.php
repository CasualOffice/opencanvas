<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Controller;

use OCA\OpenCanvas\Service\ConfigService;
use OCA\OpenCanvas\Service\DiscoveryService;
use OCA\OpenCanvas\Wopi\CheckReport;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IRequest;

/** Admin settings backend. Admin-only (no NoAdminRequired attribute). Secrets never leave. */
class SettingsController extends Controller {
	public function __construct(
		string $appName,
		IRequest $request,
		private ConfigService $config,
		private DiscoveryService $discovery,
	) {
		parent::__construct($appName, $request);
	}

	public function get(): JSONResponse {
		return new JSONResponse($this->config->forAdmin());
	}

	/** @param array<string, string|bool> $settings */
	public function set(array $settings): JSONResponse {
		try {
			foreach ($settings as $key => $value) {
				if ($key === 'opencanvas_api_key') {
					$this->config->setApiKey((string)$value); // sensitive; never sent back
				} elseif (in_array($key, ConfigService::KEYS_STRING, true)) {
					$this->config->setString($key, (string)$value);
				} elseif (in_array($key, ConfigService::KEYS_BOOL, true)) {
					$this->config->setBool($key, filter_var($value, FILTER_VALIDATE_BOOLEAN));
				} else {
					return new JSONResponse(['error' => 'UNKNOWN_SETTING', 'key' => $key], Http::STATUS_BAD_REQUEST);
				}
			}
		} catch (\InvalidArgumentException $e) {
			return new JSONResponse(['error' => 'INVALID', 'message' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
		}
		return new JSONResponse($this->config->forAdmin());
	}

	/**
	 * Connection check (S12b-S12f): OpenCanvas answers, opens .ocanvas, publishes a proof key, and
	 * accepts this Nextcloud (a test launch). The WOPI base is what OpenCanvas's `wopi_allowlist`
	 * must contain.
	 */
	public function check(): JSONResponse {
		if ($this->config->internalUrl() === '') {
			return new JSONResponse(['error' => 'NOT_CONFIGURED'], Http::STATUS_BAD_REQUEST);
		}
		$xml = $this->discovery->xml(true, 10);
		$health = $xml === null ? null : $this->discovery->health();
		$launch = $xml === null ? ['status' => null, 'code' => null] : $this->discovery->testLaunch();
		return new JSONResponse(CheckReport::build(
			$this->config->internalUrl(),
			$xml,
			$this->discovery->lastError(),
			($health['ok'] ?? false) === true,
			isset($health['version']) && is_string($health['version']) ? $health['version'] : null,
			$launch['status'],
			$launch['code'],
			$this->config->wopiBase(),
		));
	}

	/** Rotates the token secret: every open canvas must relaunch. */
	public function rotateSecret(): JSONResponse {
		$this->config->rotateTokenSecret();
		return new JSONResponse(['rotated' => true]);
	}
}
