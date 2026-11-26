<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Command;

use OCA\OpenCanvas\AppInfo\Application;
use OCA\OpenCanvas\Service\SearchIndexService;
use OCP\Files\File;
use OCP\Files\IRootFolder;
use OCP\IUser;
use OCP\IUserManager;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

/**
 * `occ opencanvas:search-index [user…]`: (re)indexes existing `.ocanvas` files for unified
 * search (SRCH-05). New saves index themselves; run this once after installing or upgrading.
 */
class IndexCanvases extends Command {
	public function __construct(
		private SearchIndexService $index,
		private IRootFolder $root,
		private IUserManager $users,
	) {
		parent::__construct();
	}

	protected function configure(): void {
		$this->setName('opencanvas:search-index')
			->setDescription('Index the text of existing canvases for Nextcloud search')
			->addArgument('user', InputArgument::OPTIONAL | InputArgument::IS_ARRAY, 'Only these users\' files');
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		$seen = [];
		$n = 0;
		$run = function (IUser $u) use (&$seen, &$n, $output): void {
			foreach ($this->root->getUserFolder($u->getUID())->searchByMime(Application::MIME) as $node) {
				$id = (int)$node->getId();
				if (!$node instanceof File || isset($seen[$id])) {
					continue;
				}
				$seen[$id] = true;
				if ($this->index->index($node)) {
					$n++;
				}
			}
			$output->writeln("{$u->getUID()}: done", OutputInterface::VERBOSITY_VERBOSE);
		};
		$only = $input->getArgument('user');
		if ($only) {
			foreach ($only as $uid) {
				$u = $this->users->get($uid);
				if ($u) {
					$run($u);
				}
			}
		} else {
			$this->users->callForSeenUsers($run);
		}
		$output->writeln("Indexed $n canvases");
		return 0;
	}
}
