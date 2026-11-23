<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Service;

use OCA\OpenCanvas\AppInfo\Application;
use OCP\IAppConfig;
use OCP\IURLGenerator;
use OCP\Security\ISecureRandom;

/**
 * Admin settings, stored as app config. The token secret is generated on first use and stored
 * as a sensitive value (never returned to the browser, never logged).
 */
class ConfigService {
	public const KEYS_STRING = ['opencanvas_url', 'opencanvas_internal_url', 'wopi_base'];
	public const KEYS_BOOL = ['allow_public_links', 'allow_comment_role'];

	public function __construct(
		private IAppConfig $appConfig,
		private IURLGenerator $urlGenerator,
		private ISecureRandom $random,
	) {
	}

	/** Where browsers reach OpenCanvas, e.g. https://canvas.example.com (no trailing slash). */
	public function publicUrl(): string {
		return rtrim($this->appConfig->getValueString(Application::APP_ID, 'opencanvas_url'), '/');
	}

	/** Where this server reaches OpenCanvas for discovery; defaults to the public URL. */
	public function internalUrl(): string {
		$v = rtrim($this->appConfig->getValueString(Application::APP_ID, 'opencanvas_internal_url'), '/');
		return $v !== '' ? $v : $this->publicUrl();
	}

	/**
	 * The WOPI base OpenCanvas calls: `{base}/files/{fileId}` is the WOPISrc, and the room id.
	 * It must be stable (one room per file) and must match OpenCanvas's `wopi_allowlist`. Set it
	 * explicitly behind a proxy or when OpenCanvas reaches Nextcloud at another address.
	 */
	public function wopiBase(): string {
		$v = rtrim($this->appConfig->getValueString(Application::APP_ID, 'wopi_base'), '/');
		if ($v !== '') {
			return $v;
		}
		// Always with index.php, so the URL does not change when pretty URLs are switched on.
		return rtrim($this->urlGenerator->getAbsoluteURL('/index.php/apps/' . Application::APP_ID . '/wopi'), '/');
	}

	public function wopiSrc(int $fileId): string {
		return $this->wopiBase() . '/files/' . $fileId;
	}

	/** The Files link for a file id (HostEditUrl of a conflict copy). */
	public function publicNextcloudFileUrl(int $fileId): string {
		return $this->urlGenerator->getAbsoluteURL('/index.php/f/' . $fileId);
	}

	/** Nextcloud's browser origin (PostMessageOrigin). */
	public function nextcloudOrigin(): string {
		$p = parse_url($this->urlGenerator->getAbsoluteURL('/'));
		return ($p['scheme'] ?? 'https') . '://' . ($p['host'] ?? '') . (isset($p['port']) ? ':' . $p['port'] : '');
	}

	public function allowPublicLinks(): bool {
		return $this->appConfig->getValueBool(Application::APP_ID, 'allow_public_links', true);
	}

	/** Read-only shares with our `opencanvas`/`comment` share attribute get the comment role. */
	public function allowCommentRole(): bool {
		return $this->appConfig->getValueBool(Application::APP_ID, 'allow_comment_role', false);
	}

	/** OpenCanvas host id for the REST API (`X-OpenCanvas-Host`); default `nextcloud`. */
	public function hostId(): string {
		$v = $this->appConfig->getValueString(Application::APP_ID, 'opencanvas_host_id');
		return $v !== '' ? $v : 'nextcloud';
	}

	/** The host's OpenCanvas `api_key` (sensitive; set with occ … --sensitive). Empty = off. */
	public function apiKey(): string {
		return $this->appConfig->getValueString(Application::APP_ID, 'opencanvas_api_key', '', true);
	}

	public function tokenTtl(): int {
		return 36000; // OpenCanvas's cap for a WOPI session (docs/05 §6)
	}

	public function tokenSecret(): string {
		$s = $this->appConfig->getValueString(Application::APP_ID, 'token_secret', '', true);
		if ($s === '') {
			$s = $this->random->generate(64, ISecureRandom::CHAR_ALPHANUMERIC);
			$this->appConfig->setValueString(Application::APP_ID, 'token_secret', $s, true, true);
		}
		return $s;
	}

	/** Rotating the secret invalidates every open canvas's token (they relaunch). */
	public function rotateTokenSecret(): void {
		$this->appConfig->deleteKey(Application::APP_ID, 'token_secret');
	}

	/** @return array<string, string|bool> what the admin page shows (no secrets) */
	public function forAdmin(): array {
		return [
			'opencanvas_url' => $this->publicUrl(),
			'opencanvas_internal_url' => $this->appConfig->getValueString(Application::APP_ID, 'opencanvas_internal_url'),
			'wopi_base' => $this->wopiBase(),
			'allow_public_links' => $this->allowPublicLinks(),
			'allow_comment_role' => $this->allowCommentRole(),
		];
	}

	public function setString(string $key, string $value): void {
		if (!in_array($key, self::KEYS_STRING, true)) {
			throw new \InvalidArgumentException('unknown setting');
		}
		$value = trim($value);
		if ($value !== '' && !self::isHttpUrl($value)) {
			throw new \InvalidArgumentException('not an http(s) URL');
		}
		$this->appConfig->setValueString(Application::APP_ID, $key, rtrim($value, '/'));
	}

	public function setBool(string $key, bool $value): void {
		if (!in_array($key, self::KEYS_BOOL, true)) {
			throw new \InvalidArgumentException('unknown setting');
		}
		$this->appConfig->setValueBool(Application::APP_ID, $key, $value);
	}

	public static function isHttpUrl(string $url): bool {
		$p = parse_url($url);
		return is_array($p) && in_array($p['scheme'] ?? '', ['http', 'https'], true)
			&& ($p['host'] ?? '') !== '' && !isset($p['user']) && !isset($p['query']) && !isset($p['fragment']);
	}
}
