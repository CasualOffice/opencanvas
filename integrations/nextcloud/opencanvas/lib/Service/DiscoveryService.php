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

	/** The discovery XML, cached for an hour; `$refresh` re-reads it (key rotation). */
	public function xml(bool $refresh = false): ?string {
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
				'timeout' => 5,
				'allow_redirects' => false,
			]);
			$xml = (string)$res->getBody();
		} catch (\Throwable $e) {
			$this->logger->warning('OpenCanvas discovery unreachable', ['app' => 'opencanvas', 'exception' => $e->getMessage()]);
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
}
