<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Service;

use OCA\OpenCanvas\AppInfo\Application;
use OCA\OpenCanvas\Search\SearchText;
use OCP\Files\File;
use OCP\Files\IRootFolder;
use OCP\Files\Node;
use OCP\IDBConnection;
use OCP\ITempManager;
use OCP\IUser;

/**
 * SRCH-05 (ADR-065): keeps `oc_opencanvas_search` in step with the `.ocanvas` files and answers
 * the unified search provider. Rows hold text only; access is Nextcloud's, checked per user at
 * search time (`getById` in that user's folder), so shares and revocations apply at once.
 */
class SearchIndexService {
	private const TABLE = 'opencanvas_search';
	/** A canvas file larger than this is not read for indexing (OpenCanvas's own limit). */
	private const MAX_FILE = 100 * 1024 * 1024;
	/** Candidate rows read per search page before the access check. */
	private const CANDIDATES = 200;

	public function __construct(
		private IDBConnection $db,
		private IRootFolder $root,
		private ITempManager $temp,
	) {
	}

	public static function isCanvas(Node $node): bool {
		return $node instanceof File
			&& ($node->getMimetype() === Application::MIME || str_ends_with(strtolower($node->getName()), '.ocanvas'));
	}

	/** Re-reads `search.json` from the file; a file without one (older than 0.3) drops its row. */
	public function index(File $file): bool {
		$id = (int)$file->getId();
		if ($id <= 0) {
			return false;
		}
		$entry = null;
		if ($file->getSize() <= self::MAX_FILE) {
			$tmp = $this->temp->getTemporaryFile('.ocanvas');
			try {
				$in = $file->fopen('r');
				$out = fopen($tmp, 'wb');
				if ($in !== false && $out !== false) {
					stream_copy_to_stream($in, $out, self::MAX_FILE + 1);
				}
				if (is_resource($in)) {
					fclose($in);
				}
				if (is_resource($out)) {
					fclose($out);
				}
				$entry = SearchText::fromZipFile($tmp);
			} finally {
				@unlink($tmp);
			}
		}
		$this->remove($id);
		if ($entry === null) {
			return false;
		}
		$qb = $this->db->getQueryBuilder();
		$qb->insert(self::TABLE)->values([
			'fileid' => $qb->createNamedParameter($id, \OCP\DB\QueryBuilder\IQueryBuilder::PARAM_INT),
			'title' => $qb->createNamedParameter(mb_substr($entry['title'], 0, 255)),
			'lines' => $qb->createNamedParameter(json_encode($entry['lines'], JSON_UNESCAPED_UNICODE)),
			'hay' => $qb->createNamedParameter(SearchText::haystack($entry)),
			'mtime' => $qb->createNamedParameter((int)$file->getMTime(), \OCP\DB\QueryBuilder\IQueryBuilder::PARAM_INT),
		])->executeStatement();
		return true;
	}

	/** TALK-01 card preview: the canvas's first lines of text, from its index row ('' when none). */
	public function firstLines(int $fileId, int $n = 3): string {
		$qb = $this->db->getQueryBuilder();
		$qb->select('lines')->from(self::TABLE)->where($qb->expr()->eq('fileid', $qb->createNamedParameter($fileId, \OCP\DB\QueryBuilder\IQueryBuilder::PARAM_INT)));
		$res = $qb->executeQuery();
		$row = $res->fetch();
		$res->closeCursor();
		$lines = is_array($row) ? json_decode((string)$row['lines'], true) : null;
		if (!is_array($lines)) {
			return '';
		}
		return implode("\n", array_slice(array_map(static fn ($l) => is_array($l) ? (string)($l['t'] ?? '') : '', $lines), 0, $n));
	}

	public function remove(int $fileId): void {
		$qb = $this->db->getQueryBuilder();
		$qb->delete(self::TABLE)->where($qb->expr()->eq('fileid', $qb->createNamedParameter($fileId, \OCP\DB\QueryBuilder\IQueryBuilder::PARAM_INT)))->executeStatement();
	}

	/**
	 * Canvases `$user` may open that match `$term`, in pages of canvases: `[hits, next]` where
	 * each hit is `{file, title, blockId, path, snippet}` and `next` the cursor of the next page
	 * (null at the end).
	 *
	 * @return array{0: list<array{file: File, title: string, blockId: ?string, path: string, snippet: string}>, 1: ?int}
	 */
	public function search(IUser $user, string $term, int $limit, int $cursor = 0): array {
		$word = SearchText::longestWord($term);
		if ($word === '' || mb_strlen($word) < 2) {
			return [[], null];
		}
		$qb = $this->db->getQueryBuilder();
		$qb->select('fileid', 'title', 'lines')
			->from(self::TABLE)
			->where($qb->expr()->iLike('hay', $qb->createNamedParameter('%' . $this->db->escapeLikeParameter($word) . '%')))
			->orderBy('mtime', 'DESC')
			->addOrderBy('fileid', 'DESC')
			->setFirstResult($cursor)
			->setMaxResults(self::CANDIDATES);
		$rows = $qb->executeQuery()->fetchAll();
		$folder = $this->root->getUserFolder($user->getUID());
		$hits = [];
		$used = 0;
		foreach ($rows as $row) {
			$used++;
			// Nextcloud decides: a file this person cannot open is never shown, not even its title.
			$nodes = $folder->getById((int)$row['fileid']);
			$file = $nodes[0] ?? null;
			if (!$file instanceof File) {
				continue;
			}
			$entry = ['title' => (string)$row['title'], 'lines' => json_decode((string)$row['lines'], true) ?: []];
			foreach (SearchText::matches($entry, $term, 1) as $m) {
				$hits[] = ['file' => $file, 'title' => SearchText::displayTitle($entry['title'], $file->getName())] + $m;
			}
			if (count($hits) >= $limit) {
				break;
			}
		}
		$more = count($rows) === self::CANDIDATES || $used < count($rows);
		return [$hits, $more ? $cursor + $used : null];
	}
}
