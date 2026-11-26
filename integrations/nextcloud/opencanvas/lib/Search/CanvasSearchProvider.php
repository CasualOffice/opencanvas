<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Search;

use OCA\OpenCanvas\AppInfo\Application;
use OCA\OpenCanvas\Service\SearchIndexService;
use OCP\Files\IRootFolder;
use OCP\IL10N;
use OCP\IURLGenerator;
use OCP\IUser;
use OCP\Search\IProvider;
use OCP\Search\ISearchQuery;
use OCP\Search\SearchResult;
use OCP\Search\SearchResultEntry;

/**
 * SRCH-05 (ADR-065): canvases in Nextcloud's unified search. Text comes from the app's index of
 * `search.json` (SearchIndexService); results are only files the person can open, each opening
 * the canvas on the app's full page at the matching block (`#block=<id>`, sent to the editor as
 * `Action_ScrollToBlock`).
 */
class CanvasSearchProvider implements IProvider {
	public function __construct(
		private SearchIndexService $index,
		private IRootFolder $root,
		private IURLGenerator $url,
		private IL10N $l10n,
	) {
	}

	public function getId(): string {
		return Application::APP_ID;
	}

	public function getName(): string {
		return $this->l10n->t('Canvases');
	}

	public function getOrder(string $route, array $routeParameters): ?int {
		// First on the app's own pages, after Files elsewhere.
		return str_starts_with($route, Application::APP_ID . '.') ? -1 : 25;
	}

	public function search(IUser $user, ISearchQuery $query): SearchResult {
		$limit = max(1, min(50, $query->getLimit()));
		$cursor = (int)($query->getCursor() ?? 0);
		[$hits, $next] = $this->index->search($user, $query->getTerm(), $limit, $cursor);
		$folder = $this->root->getUserFolder($user->getUID());
		$icon = $this->url->getAbsoluteURL($this->url->imagePath(Application::APP_ID, 'ocanvas.svg'));
		$entries = [];
		foreach ($hits as $h) {
			$file = $h['file'];
			$where = dirname((string)$folder->getRelativePath($file->getPath()));
			$sub = array_filter([$h['snippet'], $h['path'], $where === '/' || $where === '.' ? '' : ltrim($where, '/')]);
			$link = $this->url->linkToRouteAbsolute('opencanvas.launch.open', ['fileId' => $file->getId()])
				. ($h['blockId'] ? '#block=' . rawurlencode($h['blockId']) : '');
			$entries[] = new SearchResultEntry('', $h['title'], implode(' · ', $sub), $link, $icon);
		}
		return $next === null
			? SearchResult::complete($this->getName(), $entries)
			: SearchResult::paginated($this->getName(), $entries, $next);
	}
}
