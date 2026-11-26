<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Controller;

use OCA\OpenCanvas\Service\ConfigService;
use OCA\OpenCanvas\Service\TokenService;
use OCA\OpenCanvas\Talk\CanvasCard;
use OCA\OpenCanvas\Talk\MeetingService;
use OCA\OpenCanvas\Talk\RoomActor;
use OCA\OpenCanvas\Talk\SpreedGateway;
use OCA\OpenCanvas\Talk\TalkException;
use OCA\OpenCanvas\Wopi\Role;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IRequest;
use OCP\IURLGenerator;
use OCP\IUserSession;

/**
 * TALK-01: the Canvas panel's API in Talk (docs/prototypes/v04-approved/nextcloud-talk.html).
 * Everyone must be a participant of the conversation; guests (public conversations) are known by
 * their Talk session. Chat messages are posted by the browser through Talk's own chat API; this
 * controller shares files with the conversation and runs meeting canvases.
 */
class TalkController extends Controller {
	public function __construct(
		string $appName,
		IRequest $request,
		private MeetingService $meetings,
		private SpreedGateway $talk,
		private TokenService $tokens,
		private ConfigService $config,
		private IUserSession $userSession,
		private IURLGenerator $urls,
	) {
		parent::__construct($appName, $request);
	}

	#[NoAdminRequired]
	#[PublicPage]
	public function state(string $room): JSONResponse {
		return $this->run($room, fn (RoomActor $a) => $this->meetings->state($room, $a) + ['me' => ['id' => $a->id, 'name' => $a->name]]);
	}

	#[NoAdminRequired]
	#[PublicPage]
	public function start(string $room): JSONResponse {
		return $this->run($room, fn (RoomActor $a) => ['id' => $this->meetings->start($room, $a)->id]);
	}

	/** Launch data for the meeting canvas (form-POST into the panel's frame, like files). */
	#[NoAdminRequired]
	#[PublicPage]
	public function launch(string $room, int $id): JSONResponse {
		return $this->run($room, function (RoomActor $a) use ($room, $id) {
			$m = $this->meetings->meeting($id);
			if ($m === null || $m->room !== $room || $this->meetings->launched($id, $a) === null) {
				throw new TalkException('GONE');
			}
			if ($this->config->publicUrl() === '') {
				throw new TalkException('NOT_CONFIGURED');
			}
			$minted = $a->isGuest()
				? $this->tokens->mint(-$id, null, 'talk:' . $room, $a->id, $a->name, Role::EDIT)
				: $this->tokens->mint(-$id, $a->id, null, null, null, Role::EDIT);
			return [
				'action' => $this->config->publicUrl() . '/v1/launch?WOPISrc=' . rawurlencode($this->config->meetingWopiSrc($id)),
				'access_token' => $minted['token'],
				'access_token_ttl' => $minted['ttlMs'],
				'origin' => $this->config->publicOrigin(),
				'name' => 'Meeting canvas',
			];
		});
	}

	#[NoAdminRequired]
	#[PublicPage]
	public function decide(string $room, int $id, string $action, bool $post = true): JSONResponse {
		return $this->run($room, function (RoomActor $a) use ($room, $id, $action, $post) {
			$m = $this->meetings->decide($room, $id, $a, $action, $post);
			return ['state' => $m->state, 'savedFileId' => $m->savedFileId];
		});
	}

	#[NoAdminRequired]
	#[PublicPage]
	public function options(string $room, int $id, ?bool $guestsCanEdit = null, ?bool $locked = null): JSONResponse {
		return $this->run($room, function (RoomActor $a) use ($room, $id, $guestsCanEdit, $locked) {
			$opts = array_filter(['guestsCanEdit' => $guestsCanEdit, 'locked' => $locked], static fn ($v) => $v !== null);
			$m = $this->meetings->options($room, $id, $a, $opts);
			return ['guestsCanEdit' => $m->guestsCanEdit, 'locked' => $m->locked];
		});
	}

	#[NoAdminRequired]
	public function settings(string $room, bool $participantsCanStart): JSONResponse {
		return $this->run($room, function (RoomActor $a) use ($room, $participantsCanStart) {
			$this->meetings->setParticipantsCanStart($room, $a, $participantsCanStart);
			return ['participantsCanStart' => $participantsCanStart];
		});
	}

	#[NoAdminRequired]
	#[PublicPage]
	public function follow(string $room, string $canvas = '', bool $on = false): JSONResponse {
		return $this->run($room, function (RoomActor $a) use ($room, $canvas, $on) {
			$this->meetings->follow($room, $a, $canvas, $on);
			return ['on' => $on];
		});
	}

	#[NoAdminRequired]
	#[PublicPage]
	public function followView(string $room, string $block): JSONResponse {
		return $this->run($room, function (RoomActor $a) use ($room, $block) {
			$this->meetings->followView($room, $a, $block);
			return [];
		});
	}

	/**
	 * 1a: how many people in the conversation can't open the canvas yet (guests always count), and
	 * the link to post. Posting never grants access by itself.
	 */
	#[NoAdminRequired]
	public function access(string $room, int $fileId): JSONResponse {
		return $this->run($room, function (RoomActor $a) use ($room, $fileId) {
			if (!$this->talk->canOpen($a->id, $fileId)) {
				throw new TalkException('NOT_FOUND');
			}
			$members = $this->talk->members($room);
			$missing = count(array_filter($members, fn (string $id) => str_starts_with($id, 'guest:') || !$this->talk->canOpen($id, $fileId)));
			return ['total' => count($members), 'missing' => $missing, 'link' => $this->link($fileId, $a->id)];
		});
	}

	/** 1a "Share the file with the conversation" (Can edit / Can view), then the browser posts the card. */
	#[NoAdminRequired]
	public function share(string $room, int $fileId, string $level = 'view'): JSONResponse {
		return $this->run($room, function (RoomActor $a) use ($room, $fileId, $level) {
			if ($a->isGuest() || !in_array($level, ['view', 'edit'], true)) {
				throw new TalkException('FORBIDDEN');
			}
			$this->talk->shareWithRoom($fileId, $room, $a->id, $level);
			return ['link' => $this->link($fileId, $a->id)];
		});
	}

	private function link(int $fileId, string $by): string {
		return CanvasCard::link($this->urls->linkToRouteAbsolute('opencanvas.launch.open', ['fileId' => 0]), $fileId, $by);
	}

	/** Resolves the person in the conversation, runs `$fn`, and maps refusals to their status. */
	private function run(string $room, callable $fn): JSONResponse {
		try {
			$a = $this->actor($room);
			return new JSONResponse($fn($a));
		} catch (TalkException $e) {
			return new JSONResponse(['error' => $e->getMessage()], $e->status());
		}
	}

	private function actor(string $room): RoomActor {
		if (!$this->talk->available()) {
			throw new TalkException('NOT_FOUND');
		}
		$user = $this->userSession->getUser();
		if ($user !== null) {
			return $this->meetings->actor($room, $user->getUID(), $user->getDisplayName());
		}
		return $this->talk->currentGuest($room) ?? throw new TalkException('NOT_FOUND');
	}
}
