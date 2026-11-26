<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Reference;

use OCA\OpenCanvas\Service\SearchIndexService;
use OCA\OpenCanvas\Talk\CanvasCard;
use OCP\Collaboration\Reference\IReference;
use OCP\Collaboration\Reference\IReferenceProvider;
use OCP\Collaboration\Reference\Reference;
use OCP\Files\File;
use OCP\Files\IRootFolder;
use OCP\IUserManager;
use OCP\IUserSession;

/**
 * TALK-01 1b / 5c: a canvas link posted to Talk (`/apps/opencanvas/open/{id}?talk=1&by=…`)
 * renders as the OpenCanvas card (src/reference.js). Resolved per reader (cache key = user), so
 * someone without access gets the no-access card: no path, preview or presence.
 */
class CanvasReferenceProvider implements IReferenceProvider {
	public function __construct(
		private IRootFolder $root,
		private IUserSession $session,
		private IUserManager $users,
		private SearchIndexService $index,
	) {
	}

	public function matchReference(string $referenceText): bool {
		return CanvasCard::parse($referenceText) !== null;
	}

	public function resolveReference(string $referenceText): ?IReference {
		$p = CanvasCard::parse($referenceText);
		if ($p === null) {
			return null;
		}
		$card = $this->card($p['fileId'], $p['by']);
		$ref = new Reference($referenceText);
		$ref->setTitle($card['title']);
		$ref->setDescription($card['access'] ? implode(' ', $card['preview']) : "You don't have access to this canvas.");
		$ref->setUrl($referenceText);
		$ref->setRichObject(CanvasCard::RICH_TYPE, $card);
		return $ref;
	}

	/**
	 * The card for the signed-in reader now. The widget asks again on display (TalkController
	 * card): Nextcloud's resolve answer is browser-cached for an hour, and a share given after the
	 * post must show at once.
	 */
	public function card(int $fileId, string $by): array {
		$p = ['fileId' => $fileId, 'by' => $by];
		$sharer = $p['by'] !== '' ? ($this->users->getDisplayName($p['by']) ?? $p['by']) : '';
		$uid = $this->session->getUser()?->getUID();
		$file = null;
		if ($uid !== null) {
			try {
				$node = $this->root->getUserFolder($uid)->getFirstNodeById($p['fileId']);
				$file = $node instanceof File && $node->isReadable() ? $node : null;
			} catch (\Throwable) {
			}
		}
		if ($file !== null) {
			$path = (string)$this->root->getUserFolder($uid)->getRelativePath($file->getPath());
			$card = CanvasCard::build($p['fileId'], $file->getName(), $path, $this->index->firstLines($p['fileId']), $file->getMTime(), $sharer, true);
		} else {
			// The title as posted is not known without access: the file's name from the sharer's side.
			$name = 'Canvas';
			if ($p['by'] !== '') {
				try {
					$n = $this->root->getUserFolder($p['by'])->getFirstNodeById($p['fileId']);
					$name = $n !== null ? $n->getName() : $name;
				} catch (\Throwable) {
				}
			}
			$card = CanvasCard::build($p['fileId'], $name, '', '', 0, $sharer, false);
		}
		$card['by'] = $p['by'];
		return $card;
	}

	/** Per file, so sharing it with the conversation can drop every reader's cached card at once. */
	public function getCachePrefix(string $referenceId): string {
		return self::cachePrefix(CanvasCard::parse($referenceId)['fileId'] ?? 0);
	}

	public static function cachePrefix(int $fileId): string {
		return 'opencanvas-' . $fileId;
	}

	public function getCacheKey(string $referenceId): ?string {
		return $this->session->getUser()?->getUID() ?? '';
	}
}
