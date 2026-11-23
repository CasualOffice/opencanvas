<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Service;

use OCA\OpenCanvas\Wopi\ProofVerifier;
use OCP\Http\Client\IClientService;
use OCP\ICache;
use OCP\ICacheFactory;
use Psr\Log\LoggerInterface;

/** Fetches and caches OpenCanvas's WOPI discovery (`GET /hosting/discovery`). */
class DiscoveryService {
	private ICache $cache;

	public function __construct(
		private ConfigService $config,
		private IClientService $clientService,
		ICacheFactory $cacheFactory,
		private LoggerInterface $logger,
	) {
		$this->cache = $cacheFactory->createDistributed('opencanvas-discovery');
	}

	private ?string $lastError = null;

	/** Why the last discovery fetch failed (for the admin check), e.g. "timed out after 10 s". */
	public function lastError(): ?string {
		return $this->lastError;
	}

	/** The discovery XML, cached for an hour; `$refresh` re-reads it (key rotation). */
	public function xml(bool $refresh = false, int $timeout = 5): ?string {
		$base = $this->config->internalUrl();
		if ($base === '') {
			return null;
		}
		$key = 'xml-' . md5($base);
		if (!$refresh) {
			$hit = $this->cache->get($key);
			if (is_string($hit) && $hit !== '') {
				return $hit;
			}
		}
		try {
			$res = $this->clientService->newClient()->get($base . '/hosting/discovery', [
				'timeout' => $timeout,
				'allow_redirects' => false,
			]);
			$xml = (string)$res->getBody();
		} catch (\Throwable $e) {
			$this->logger->warning('OpenCanvas discovery unreachable', ['app' => 'opencanvas', 'exception' => $e->getMessage()]);
			$this->lastError = self::describe($e, $timeout);
			return null;
		}
		$this->cache->set($key, $xml, 3600);
		return $xml;
	}

	/** @return array{current: ?string, old: ?string} */
	public function proofKeys(bool $refresh = false): array {
		$xml = $this->xml($refresh);
		return $xml === null ? ['current' => null, 'old' => null] : ProofVerifier::keysFromDiscovery($xml);
	}

	/** `GET /healthz`: {ok, version}, or null. */
	public function health(): ?array {
		try {
			$res = $this->clientService->newClient()->get($this->config->internalUrl() . '/healthz', ['timeout' => 5, 'allow_redirects' => false]);
			$j = json_decode((string)$res->getBody(), true);
			return is_array($j) ? $j : null;
		} catch (\Throwable) {
			return null;
		}
	}

	/**
	 * A test launch with a probe token for file 0: OpenCanvas answers 403 WOPISRC_NOT_ALLOWED when
	 * this Nextcloud is not on its allow-list, 401 TOKEN_INVALID once it reached CheckFileInfo
	 * (allowed, and it reaches us), 5xx when it can't reach this Nextcloud.
	 *
	 * @return array{status: ?int, code: ?string}
	 */
	public function testLaunch(): array {
		$url = $this->config->internalUrl() . '/v1/launch?WOPISrc=' . rawurlencode($this->config->wopiSrc(0));
		try {
			$res = $this->clientService->newClient()->post($url, [
				'timeout' => 15,
				'allow_redirects' => false,
				'http_errors' => false,
				'headers' => ['Accept' => 'application/json'],
				'form_params' => ['access_token' => 'connection-check', 'access_token_ttl' => '0'],
			]);
			$j = json_decode((string)$res->getBody(), true);
			$code = is_array($j) && isset($j['error']['code']) && is_string($j['error']['code']) ? $j['error']['code'] : null;
			return ['status' => $res->getStatusCode(), 'code' => $code];
		} catch (\Throwable $e) {
			return ['status' => null, 'code' => null];
		}
	}

	/** Remembered for 5 minutes, so an error page can tell users and admins what happened (S13d/e). */
	public function markProofFailure(): void {
		$this->cache->set('proof-failed', time(), 300);
	}

	public function recentProofFailure(): bool {
		return is_int($this->cache->get('proof-failed'));
	}

	private static function describe(\Throwable $e, int $timeout): string {
		$m = $e->getMessage();
		if (stripos($m, 'timed out') !== false || stripos($m, 'timeout') !== false) {
			return 'timed out after ' . $timeout . ' s';
		}
		if (stripos($m, 'refused') !== false) {
			return 'connection refused';
		}
		if (stripos($m, 'resolve') !== false) {
			return 'the host name could not be resolved';
		}
		if (stripos($m, 'local') !== false && stripos($m, 'remote') !== false) {
			return 'Nextcloud blocks local addresses';
		}
		return 'no answer';
	}
}
