<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Listener;

use OCA\OpenCanvas\Service\SearchIndexService;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Files\Events\Node\NodeCopiedEvent;
use OCP\Files\Events\Node\NodeDeletedEvent;
use OCP\Files\Events\Node\NodeWrittenEvent;
use OCP\Files\File;
use Psr\Log\LoggerInterface;

/**
 * SRCH-05: every write of an `.ocanvas` (OpenCanvas's PutFile, a conflict copy, an upload, a
 * WebDAV PUT, a copy) re-reads its `search.json` into the index; a delete drops the row.
 * Indexing never fails the write: errors are logged without content.
 *
 * @template-implements IEventListener<NodeWrittenEvent|NodeCopiedEvent|NodeDeletedEvent>
 */
class IndexCanvasListener implements IEventListener {
	public function __construct(
		private SearchIndexService $index,
		private LoggerInterface $logger,
	) {
	}

	public function handle(Event $event): void {
		try {
			if ($event instanceof NodeDeletedEvent) {
				$node = $event->getNode();
				if (SearchIndexService::isCanvas($node)) {
					$this->index->remove((int)$node->getId());
				}
				return;
			}
			$node = $event instanceof NodeCopiedEvent ? $event->getTarget() : ($event instanceof NodeWrittenEvent ? $event->getNode() : null);
			if ($node instanceof File && SearchIndexService::isCanvas($node)) {
				$this->index->index($node);
			}
		} catch (\Throwable $e) {
			$this->logger->warning('OpenCanvas: could not index a canvas for search', ['app' => 'opencanvas', 'exception' => $e::class]);
		}
	}
}
