<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Wopi;

/**
 * Maps what Nextcloud says about a file for one person to the CheckFileInfo fields OpenCanvas
 * reads (docs/05 §6): role and export/print/copy flags. Pure function, no Nextcloud dependency.
 *
 * Nextcloud side (see DESIGN.md §5):
 *  - permission bits are `OCP\Constants::PERMISSION_*` (same values as below) as Nextcloud
 *    computes them for this person: the node's own permissions, which already fold in the
 *    received share's permissions, or the public link share's permissions for guests;
 *  - `downloadAllowed` is false when the share has the attribute `permissions`/`download` = false
 *    ("Allow download and sync" unticked);
 *  - `hideDownload` is the public link's "Hide download" option;
 *  - `commentAttribute` is our own share attribute `opencanvas`/`comment` = true.
 *
 * OpenCanvas side: `UserCanWrite` and not `ReadOnly` → edit; else `OpenCanvas_UserCanComment` →
 * comment; else view. `DisableExport` → no export, download or print; `HideExportOption` → no
 * export; `DisablePrint` → no print.
 */
final class PermissionMapper {
	public const READ = 1;
	public const UPDATE = 2;
	public const CREATE = 4;

	/**
	 * @return array<string, bool|string>|null CheckFileInfo flags plus `role`, or null when the
	 *                                          person may not read the file at all
	 */
	public static function map(
		int $permissions,
		bool $parentCreatable,
		bool $downloadAllowed,
		bool $hideDownload,
		bool $commentAttribute,
		string $maxRole,
		bool $allowCommentRole,
	): ?array {
		if (($permissions & self::READ) === 0 || !Role::isValid($maxRole)) {
			return null;
		}
		if (($permissions & self::UPDATE) !== 0) {
			$role = Role::EDIT;
		} elseif ($allowCommentRole && $commentAttribute) {
			$role = Role::COMMENT;
		} else {
			$role = Role::VIEW;
		}
		$role = Role::min($role, $maxRole);
		$noDownload = !$downloadAllowed || $hideDownload;
		return [
			'role' => $role,
			'UserCanWrite' => $role === Role::EDIT,
			'ReadOnly' => $role !== Role::EDIT,
			'OpenCanvas_UserCanComment' => $role !== Role::VIEW,
			// A conflict copy is created next to the file: needs create rights in its folder.
			'UserCanNotWriteRelative' => !($role === Role::EDIT && $parentCreatable),
			// No download means no export, download or print (each would hand out the content).
			'DisableExport' => $noDownload,
			'DisablePrint' => $noDownload,
			'HideExportOption' => $noDownload,
		];
	}
}
