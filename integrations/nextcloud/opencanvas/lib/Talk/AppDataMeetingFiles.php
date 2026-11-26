<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Talk;

use OCP\Files\Folder;
use OCP\Files\IAppData;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\Files\SimpleFS\ISimpleFolder;

/** Meeting canvases in the app's data folder `meetings/<id>.ocanvas`; saving writes into Files. */
class AppDataMeetingFiles implements MeetingFiles {
	public function __construct(
		private IAppData $appData,
		private IRootFolder $root,
	) {
	}

	public function create(int $id, string $bytes): void {
		$this->folder()->newFile($id . '.ocanvas', $bytes);
	}

	public function read(int $id): ?string {
		try {
			return $this->folder()->getFile($id . '.ocanvas')->getContent();
		} catch (NotFoundException) {
			return null;
		}
	}

	public function write(int $id, string $bytes): void {
		$f = $this->folder();
		if ($f->fileExists($id . '.ocanvas')) {
			$f->getFile($id . '.ocanvas')->putContent($bytes);
		} else {
			$f->newFile($id . '.ocanvas', $bytes);
		}
	}

	public function delete(int $id): void {
		try {
			$this->folder()->getFile($id . '.ocanvas')->delete();
		} catch (NotFoundException) {
		}
	}

	public function saveToTalk(string $userId, string $folder, string $name, string $bytes): int {
		$home = $this->root->getUserFolder($userId);
		$path = '/' . trim($folder, '/');
		$dir = $home->nodeExists($path) ? $home->get($path) : $home->newFolder($path);
		if (!$dir instanceof Folder) {
			throw new TalkException('FORBIDDEN');
		}
		return $dir->newFile($dir->getNonExistingName($name), $bytes)->getId();
	}

	private function folder(): ISimpleFolder {
		try {
			return $this->appData->getFolder('meetings');
		} catch (NotFoundException) {
			return $this->appData->newFolder('meetings');
		}
	}
}
