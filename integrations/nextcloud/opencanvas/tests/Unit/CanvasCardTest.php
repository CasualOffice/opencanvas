<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Tests\Unit;

use OCA\OpenCanvas\Talk\CanvasCard;
use PHPUnit\Framework\TestCase;

/** TALK-01 1b and 5c: the card a canvas posted to Talk shows, and what it hides without access. */
class CanvasCardTest extends TestCase {
	public function testTheLinkCarriesTheFileAndTheSharer(): void {
		$url = CanvasCard::link('https://cloud.example/index.php/apps/opencanvas/open/', 42, 'jonas');
		$this->assertSame('https://cloud.example/index.php/apps/opencanvas/open/42?talk=1&by=jonas', $url);
		$this->assertSame(['fileId' => 42, 'by' => 'jonas'], CanvasCard::parse($url));
		// The router's link for id 0 (what the controller has) ends in /0 (found in the scripted run).
		$this->assertSame($url, CanvasCard::link('https://cloud.example/index.php/apps/opencanvas/open/0', 42, 'jonas'));
		$this->assertSame(['fileId' => 42, 'by' => ''], CanvasCard::parse('https://cloud.example/apps/opencanvas/open/42'));
		$this->assertNull(CanvasCard::parse('https://cloud.example/apps/files/42'));
		$this->assertNull(CanvasCard::parse('https://cloud.example/apps/opencanvas/open/x'));
	}

	public function testWithAccessTheCardHasPathPreviewAndEditedTime(): void {
		$c = CanvasCard::build(42, 'Q1 launch plan.ocanvas', '/Launch/Q1 launch plan.ocanvas', 'Goals' . "\n" . 'Ship onboarding by March 14.' . "\n" . 'third line', 1700000000, 'Jonas Weber', true);
		$this->assertSame('Q1 launch plan', $c['title']);
		$this->assertSame('Files / Launch / Q1 launch plan.ocanvas', $c['where']);
		$this->assertSame(['Goals', 'Ship onboarding by March 14.'], $c['preview']);
		$this->assertSame(1700000000, $c['mtime']);
		$this->assertTrue($c['access']);
	}

	public function testWithoutAccessNoPreviewNoPathOnlyTheTitleAndTheSharer(): void {
		$c = CanvasCard::build(42, 'Q1 launch plan.ocanvas', '', '', 0, 'Jonas Weber', false);
		$this->assertSame(['fileId' => 42, 'title' => 'Q1 launch plan', 'access' => false, 'sharer' => 'Jonas Weber'], $c);
	}
}
