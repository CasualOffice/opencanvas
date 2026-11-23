<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Tests\Unit;

use OCA\OpenCanvas\Wopi\PermissionMapper as M;
use OCA\OpenCanvas\Wopi\Role;
use PHPUnit\Framework\TestCase;

final class PermissionMapperTest extends TestCase {
	private const ALL = 31; // read, update, create, delete, share

	private function map(int $perms, array $o = []): ?array {
		return M::map(
			$perms,
			$o['parentCreatable'] ?? true,
			$o['download'] ?? true,
			$o['hideDownload'] ?? false,
			$o['commentAttr'] ?? false,
			$o['maxRole'] ?? Role::EDIT,
			$o['allowComment'] ?? false,
		);
	}

	public function testNoReadMeansNoAccess(): void {
		$this->assertNull($this->map(0));
		$this->assertNull($this->map(M::UPDATE)); // update without read is not access
	}

	public function testUpdateMeansEdit(): void {
		$f = $this->map(self::ALL);
		$this->assertSame(Role::EDIT, $f['role']);
		$this->assertTrue($f['UserCanWrite']);
		$this->assertFalse($f['ReadOnly']);
		$this->assertFalse($f['UserCanNotWriteRelative']);
		$this->assertFalse($f['DisableExport']);
	}

	public function testReadOnlyShareIsView(): void {
		$f = $this->map(M::READ);
		$this->assertSame(Role::VIEW, $f['role']);
		$this->assertFalse($f['UserCanWrite']);
		$this->assertTrue($f['ReadOnly']);
		$this->assertFalse($f['OpenCanvas_UserCanComment']);
		$this->assertTrue($f['UserCanNotWriteRelative']);
	}

	public function testCommentNeedsTheAttributeAndTheAdminSwitch(): void {
		$this->assertSame(Role::VIEW, $this->map(M::READ, ['commentAttr' => true])['role']);
		$this->assertSame(Role::VIEW, $this->map(M::READ, ['allowComment' => true])['role']);
		$f = $this->map(M::READ, ['commentAttr' => true, 'allowComment' => true]);
		$this->assertSame(Role::COMMENT, $f['role']);
		$this->assertTrue($f['OpenCanvas_UserCanComment']);
		$this->assertFalse($f['UserCanWrite']);
	}

	public function testTokenCapLowersTheRole(): void {
		$this->assertSame(Role::VIEW, $this->map(self::ALL, ['maxRole' => Role::VIEW])['role']);
		$this->assertSame(Role::COMMENT, $this->map(self::ALL, ['maxRole' => Role::COMMENT])['role']);
		$this->assertNull($this->map(self::ALL, ['maxRole' => 'owner']));
	}

	public function testNoDownloadDisablesExportAndPrint(): void {
		foreach ([['download' => false], ['hideDownload' => true]] as $o) {
			$f = $this->map(self::ALL, $o);
			$this->assertTrue($f['DisableExport']);
			$this->assertTrue($f['DisablePrint']);
			$this->assertTrue($f['HideExportOption']);
			$this->assertSame(Role::EDIT, $f['role']); // editing is still allowed
		}
	}

	public function testConflictCopyNeedsCreateInTheFolder(): void {
		$this->assertTrue($this->map(self::ALL, ['parentCreatable' => false])['UserCanNotWriteRelative']);
	}
}
