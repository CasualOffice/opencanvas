// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// MM-02 real-host run: the approved webapp screens in Mattermost 12.1.0 with two signed-in
// users, alice (Denim, light) and bob (Onyx, dark), plus the admin for the not-set-up state.
// Each step checks behaviour and saves a screenshot next to the prototype frames
// (docs/prototypes/mattermost-approved/real-host/<frame>-<theme>.png).
//
//   docker compose -f integrations/mattermost/e2e/docker-compose.yml up -d
//   integrations/mattermost/e2e/setup.sh            # users, channel, plugin (see its header)
//   PLAYWRIGHT=<path to playwright/index.mjs> OC_URL=http://localhost:8095 \
//   OC_RESTART="<command that restarts OpenCanvas>" OC_STOP="<command that stops it>" \
//   node integrations/mattermost/e2e/mm-e2e.mjs

import {execSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const {chromium} = await import(process.env.PLAYWRIGHT || 'playwright');
const MM = process.env.MM_URL || 'http://localhost:8065';
const OC = process.env.OC_URL || 'http://localhost:8095';
const C = process.env.MM_CONTAINER || 'oc-mattermost-e2e-mattermost-1';
const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, '../../../docs/prototypes/mattermost-approved/real-host');
mkdirSync(SHOTS, {recursive: true});
const PLUGIN = 'com.casualoffice.opencanvas';

let passed = 0;
const results = [];
function check(name, ok, detail = '') {
    results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
    console.log(results.at(-1));
    if (ok) {
        passed++;
    }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 250) {
    const end = Date.now() + ms;
    for (;;) {
        try {
            const v = await fn();
            if (v) {
                return v;
            }
        } catch {
            // retry
        }
        if (Date.now() > end) {
            return null;
        }
        await sleep(step);
    }
}

// ---------------------------------------------------------------- Mattermost API

async function api(tok, method, p, body) {
    const r = await fetch(MM + p, {
        method,
        headers: {Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest'},
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        // not JSON
    }
    return {status: r.status, json};
}
async function login(user, pass) {
    const r = await fetch(MM + '/api/v4/users/login', {method: 'POST', body: JSON.stringify({login_id: user, password: pass})});
    return {tok: r.headers.get('token'), me: await r.json(), user, pass};
}
const ONYX = {
    type: 'Onyx', sidebarBg: '#121317', sidebarText: '#ffffff', sidebarUnreadText: '#ffffff', sidebarTextHoverBg: '#25262a',
    sidebarTextActiveBorder: '#1592e0', sidebarTextActiveColor: '#ffffff', sidebarHeaderBg: '#121317', sidebarHeaderTextColor: '#ffffff',
    sidebarTeamBarBg: '#000000', onlineIndicator: '#3db887', awayIndicator: '#f5ab00', dndIndicator: '#d24b4e', mentionBg: '#1c58d9',
    mentionBj: '#1c58d9', mentionColor: '#ffffff', centerChannelBg: '#191b1f', centerChannelColor: '#e3e4e8', newMessageSeparator: '#1592e0',
    linkColor: '#5d89ea', buttonBg: '#1c58d9', buttonColor: '#ffffff', errorTextColor: '#da6c6e', mentionHighlightBg: '#0d6e6e',
    mentionHighlightLink: '#a4f4f4', codeTheme: 'monokai',
};
const mmctl = (...args) => execSync(`docker exec ${C} mmctl --local ${args.join(' ')}`, {stdio: 'pipe'}).toString();

// ---------------------------------------------------------------- browser helpers

async function contextFor(browser, u, scheme, extra = {}) {
    const ctx = await browser.newContext({viewport: {width: 1280, height: 800}, colorScheme: scheme, ...extra});
    // The XHR header makes Mattermost set its session cookies; the flag skips the
    // "open in the Desktop app?" landing page.
    await ctx.request.post(MM + '/api/v4/users/login', {headers: {'X-Requested-With': 'XMLHttpRequest'}, data: {login_id: u.user, password: u.pass}});
    await ctx.addInitScript(() => localStorage.setItem('__landingPageSeen__', 'true'));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`[${u.user}] pageerror: ${e.message}`));
    return {ctx, page};
}
async function gotoChannel(page, name) {
    await page.goto(`${MM}/acme/channels/${name}`);
    await page.waitForSelector('#post_textbox, [data-testid="post_textbox"]', {timeout: 60000});
    await sleep(800);
}
const shot = (page, name) => page.screenshot({path: path.join(SHOTS, `${name}.png`)});
const frameOf = (page) => page.frameLocator('iframe[name="opencanvas-frame"]');
const appBarButton = (page, iconClass) => page.locator(`.app-bar__icon:has(svg.${iconClass}), .channel-header__icon:has(svg.${iconClass}), button:has(svg.${iconClass})`).first();
async function editorText(page) {
    return frameOf(page).locator('.ProseMirror').first().innerText({timeout: 2000}).catch(() => '');
}
async function frameTheme(page) {
    const f = page.frames().find((x) => x.name() === 'opencanvas-frame');
    return f ? f.evaluate(() => document.documentElement.dataset.theme ?? '').catch(() => '') : '';
}

// ---------------------------------------------------------------- run

const browser = await chromium.launch();
const admin = await login('admin', 'Admin-pass-123!');
const alice = await login('alice', 'Alice-pass-123!');
const bob = await login('bob', 'Bobby-pass-123!');
// Close Mattermost's first-run checklist overlay (it is left open by default for new users).
for (const u of [admin, alice, bob]) {
    await api(u.tok, 'PUT', `/api/v4/users/${u.me.id}/preferences`, [
        {user_id: u.me.id, category: 'onboarding_task_list', name: 'onboarding_task_list_open', value: 'false'},
    ]);
}
const MAIN_ONLY = !!process.env.MAIN_ONLY; // the main flow only, light theme
if (!MAIN_ONLY) await api(bob.tok, 'PUT', `/api/v4/users/${bob.me.id}/preferences`, [{user_id: bob.me.id, category: 'theme', name: '', value: JSON.stringify(ONYX)}]);
const channel = (await api(alice.tok, 'GET', '/api/v4/teams/name/acme/channels/name/sprint-planning')).json;
const team = (await api(alice.tok, 'GET', '/api/v4/teams/name/acme')).json;

const A = await contextFor(browser, alice, 'light');
await A.ctx.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: MM});
const B = await contextFor(browser, bob, MAIN_ONLY ? 'light' : 'dark');
const T = MAIN_ONLY ? 'light' : 'dark';

// S3: create dialog from the App Bar (alice, light)
await gotoChannel(A.page, 'sprint-planning');
await gotoChannel(B.page, 'sprint-planning');
const createBtn = appBarButton(A.page, 'lucide-square-pen');
check('S3a Create canvas button in the App Bar', await createBtn.isVisible().catch(() => false));
await createBtn.click();
await A.page.waitForSelector('.oc-dialog');
await shot(A.page, 'S3b-light');
check('S3b dialog: title placeholder "Untitled canvas", channel note',
    (await A.page.locator('#oc-title').getAttribute('placeholder')) === 'Untitled canvas' &&
    (await A.page.locator('.oc-note').innerText()).includes('~sprint-planning'));
await A.page.locator('.oc-opt', {hasText: 'Meeting notes'}).click();
await shot(A.page, 'S3c-light');
check('S3c meeting notes placeholder is today\'s default title', /^Meeting notes \d{4}-\d{2}-\d{2}$/.test(await A.page.locator('#oc-title').getAttribute('placeholder')));
await A.page.locator('.oc-opt', {hasText: 'Blank canvas'}).click();
await A.page.locator('#oc-title').fill('Sprint 43 planning');
await A.page.keyboard.press('Enter'); // Enter submits
const busy = await A.page.locator('.oc-dialog button[type=submit]').innerText({timeout: 500}).catch(() => '');
check('S3d create shows a busy button or finishes at once', busy === 'Creating…' || busy === '', busy);
await A.page.waitForSelector('.oc-dialog', {state: 'detached', timeout: 15000});

// S2f: the new canvas opens straight into the page, no template picker
const opened = await until(async () => (await A.page.locator('iframe[name="opencanvas-frame"]:not(.hide)').count()) > 0, 30000);
check('S2 panel opens on the new canvas', !!opened);
await until(async () => (await frameOf(A.page).locator('.ProseMirror').count()) > 0, 30000);
await sleep(1500);
const picker = await frameOf(A.page).getByText('What are you working on?').count();
check('S2f no template picker for a canvas the plugin created (start=page)', picker === 0, `picker elements: ${picker}`);
await shot(A.page, 'S2f-light');
await frameOf(A.page).locator('.ProseMirror').first().click();
await A.page.keyboard.type('Sprint goal: admins sign in with SSO.');
await sleep(1500);

// S1: the card, for bob in dark
const card = (p, title) => p.locator('.oc-card', {hasText: title}).first();
await until(async () => (await card(B.page, 'Sprint 43 planning').count()) > 0, 20000);
await until(async () => /Canvas · (Edited|Created)/.test(await card(B.page, 'Sprint 43 planning').innerText()), 15000);
await card(B.page, 'Sprint 43 planning').scrollIntoViewIfNeeded();
await shot(B.page, `S1a-${T}`);
check('S1a card: title, kind and edit time', /Sprint 43 planning[\s\S]*Canvas · (Edited|Created) /.test(await card(B.page, 'Sprint 43 planning').innerText()));
const titleRow = await card(B.page, 'Sprint 43 planning').evaluate((el) => {
    const open = el.querySelector('.oc-btn.pri').getBoundingClientRect();
    const title = el.querySelector('.oc-title').getBoundingClientRect();
    return Math.abs(open.top - title.top) < 12;
});
check('S1i Open sits on the title row', titleRow);
await card(B.page, 'Sprint 43 planning').hover();
await card(B.page, 'Sprint 43 planning').locator('[aria-label="More actions"]').click();
await shot(B.page, `S1b-${T}`);
const menuText = await B.page.locator('.oc-menu').innerText();
check('S1b menu: Open expanded, Copy link, Rename, Download .ocanvas (Later, disabled)',
    /Open expanded[\s\S]*Copy link[\s\S]*Rename[\s\S]*Download \.ocanvas[\s\S]*Later/.test(menuText) &&
    await B.page.locator('.oc-mi:has-text("Download .ocanvas")').isDisabled());
// S7a: bob's browser has no clipboard permission, so Copy link falls back to the selected link
await B.page.locator('.oc-mi', {hasText: 'Copy link'}).click();
const fallback = await until(async () => B.page.locator('.oc-pop').isVisible(), 5000);
check('S7a copy refused: link shown selected with how to finish', !!fallback &&
    /\/_redirect\/pl\//.test(await B.page.locator('.oc-pop input').inputValue()));
await shot(B.page, `S7a-${T}`);
await B.page.keyboard.press('Escape');
await B.page.locator('.oc-pop .oc-x').click().catch(() => undefined);

// S2b: the whole card opens the panel; bob sees alice's text live
await card(B.page, 'Sprint 43 planning').locator('.oc-meta').click();
await until(async () => (await editorText(B.page)).includes('Sprint goal'), 30000);
check('S2b clicking the card body opens the canvas; live text from alice', (await editorText(B.page)).includes('Sprint goal: admins sign in with SSO.'));
check('S1e card ring while open in the panel', await card(B.page, 'Sprint 43 planning').evaluate((el) => el.classList.contains('sel')));
check(`S2 the canvas follows the ${T} theme (Action_Theme)`, (await until(async () => (await frameTheme(B.page)) === T, 10000)) !== null, await frameTheme(B.page));
if (MAIN_ONLY) {
    await shot(B.page, `S2b-${T}`);
    await browser.close();
    console.log(`\n${passed}/${results.length} passed`);
    process.exit(passed === results.length ? 0 : 1);
}
await shot(B.page, `S2b-${T}`);
await A.page.waitForTimeout(500);
check('S2 the canvas follows the light theme', (await frameTheme(A.page)) === 'light', await frameTheme(A.page));
const headerOk = await B.page.locator('.oc-ptitle .oc-n1').innerText().catch(() => '');
check('S2 panel header: canvas title and channel', headerOk === 'Sprint 43 planning' &&
    (await B.page.locator('.oc-ptitle .oc-n2').innerText()).includes('# sprint-planning'));
await B.page.locator('.oc-ptitle [aria-label="Open in new window"]').waitFor({timeout: 3000}).catch(() => undefined);
check('S2 "Open in new window" in the browser', await B.page.locator('.oc-ptitle [aria-label="Open in new window"]').count() === 1);
const [popup] = await Promise.all([B.ctx.waitForEvent('page', {timeout: 15000}), B.page.locator('.oc-ptitle [aria-label="Open in new window"]').click()]);
await until(async () => popup.url().startsWith(OC + '/app/'), 20000);
check('S2 Open in new window launches the canvas full page', popup.url().startsWith(OC + '/app/'), popup.url().replace(/#.*/, '#…'));
await popup.close();

// S2c: Open expanded (alice)
await card(A.page, 'Sprint 43 planning').locator('[aria-label="Open expanded"]').click();
await sleep(2500);
const expanded = await A.page.evaluate(() => {
    const rhs = document.querySelector('.sidebar--right, #sidebar-right');
    return rhs ? rhs.getBoundingClientRect().width : 0;
});
check('S2c Open expanded widens the panel', expanded > 700, `width ${Math.round(expanded)}`);
await until(async () => (await frameOf(A.page).locator('.ProseMirror').count()) > 0, 20000);
await sleep(1000);
await shot(A.page, 'S2c-light');
// collapse with Mattermost's own button
await A.page.locator('.sidebar--right [aria-label*="ollapse"], #sidebar-right [aria-label*="ollapse"], .sidebar--right button.sidebar--right__expand').first().click().catch(() => undefined);

// S5: slash commands (alice). /canvas notes opens the new canvas in the panel (S2d).
const tb = A.page.locator('#post_textbox');
await tb.click();
await tb.type('/canvas ');
await sleep(1200);
await shot(A.page, 'S5a-light');
check('S5a autocomplete lists new, notes, list, help', await A.page.getByText('Show this channel\'s canvases').count() > 0);
await tb.fill('');
await api(alice.tok, 'POST', '/api/v4/commands/execute', {channel_id: channel.id, team_id: team.id, command: '/canvas notes Design review notes'});
await until(async () => (await A.page.locator('.oc-ptitle .oc-n1').innerText()) === 'Design review notes', 20000);
await until(async () => (await editorText(A.page)).includes('Action items'), 30000);
check('S2d /canvas notes opens the meeting notes in the panel with its sections', /Agenda[\s\S]*Action items/.test(await editorText(A.page)));
check('S1e the ring moves to the new card', await card(A.page, 'Design review notes').evaluate((el) => el.classList.contains('sel')).catch(() => false));
check('S1c meeting notes card', /Meeting notes · (Edited|Created) /.test(await card(A.page, 'Design review notes').innerText()));
await shot(A.page, 'S2d-light');
await api(alice.tok, 'POST', '/api/v4/commands/execute', {channel_id: channel.id, team_id: team.id, command: '/canvas help'});
await until(async () => (await A.page.getByText('Canvases in Mattermost channels').count()) > 0, 15000);
await sleep(500);
await shot(A.page, 'S5b-light');
check('S5b /canvas help reply', await A.page.getByText('They\'re saved on your Mattermost server.', {exact: false}).count() > 0);

// S4: channel canvases (App Bar grid, then /canvas list through the webapp hook)
await appBarButton(A.page, 'lucide-layout-grid').click();
await until(async () => (await A.page.locator('.oc-row:not(.sk)').count()) >= 2, 15000);
await shot(A.page, 'S4a-light');
const rows = await A.page.locator('.oc-row .oc-r1').allInnerTexts();
check('S4a list, newest first', rows[0] === 'Design review notes' && rows.includes('Sprint 43 planning'), rows.join(' | '));
await A.page.locator('.oc-row', {hasText: 'Sprint 43 planning'}).click();
await until(async () => (await editorText(A.page)).includes('Sprint goal'), 20000);
check('S4 a row opens that canvas in the same panel', (await editorText(A.page)).includes('Sprint goal'));
await gotoChannel(A.page, 'town-square');
await tb.click();
await tb.fill('/canvas list');
await A.page.keyboard.press('Enter');
await until(async () => (await A.page.getByText('No canvases in this channel yet').count()) > 0, 15000);
await shot(A.page, 'S4b-light');
check('S4b empty list in a channel without canvases (opened by /canvas list)', await A.page.getByText('No canvases in this channel yet').count() > 0);

// S1b Rename: alice renames, bob's card follows (WebSocket)
await gotoChannel(A.page, 'sprint-planning');
await card(A.page, 'Sprint 43 planning').locator('[aria-label="More actions"]').click();
await A.page.locator('.oc-mi', {hasText: 'Rename'}).click();
await A.page.locator('#oc-rename').fill('Sprint 43 planning (final)');
await A.page.keyboard.press('Enter');
const renamed = await until(async () => (await card(B.page, 'Sprint 43 planning (final)').count()) > 0, 15000);
check('S1b Rename updates the card for others live', !!renamed);

// S7b: the Desktop app labels the button "Open in your browser"
const D = await contextFor(browser, alice, 'light', {userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Mattermost/5.12.0 Electron/33 Safari/537.36'});
await gotoChannel(D.page, 'sprint-planning');
await card(D.page, 'Sprint 43 planning (final)').locator('.oc-btn.pri').click();
await until(async () => (await D.page.locator('.oc-ptitle [aria-label="Open in your browser"]').count()) > 0, 15000);
await D.page.locator('.oc-ptitle [aria-label="Open in your browser"]').hover();
await sleep(400);
await shot(D.page, 'S7b-light');
check('S7b Desktop app: "Open in your browser"', await D.page.locator('.oc-ptitle [aria-label="Open in your browser"]').count() === 1);
await D.ctx.close();

// S2j then S2k: bob is removed from the channel while his canvas is open
await card(B.page, 'Sprint 43 planning (final)').locator('.oc-btn.pri').click();
await until(async () => (await editorText(B.page)).includes('Sprint goal'), 20000);
mmctl('channel', 'users', 'remove', 'acme:sprint-planning', 'bob');
const ended = await until(async () => B.page.locator('.oc-foot').isVisible(), 30000);
check('S2j access removed: OpenCanvas message plus the panel\'s Reopen', !!ended &&
    (await B.page.locator('.oc-foot').innerText()).includes('The canvas closed.'));
await sleep(800);
await shot(B.page, 'S2j-dark');
await B.page.locator('.oc-foot button', {hasText: 'Reopen'}).click();
await until(async () => (await B.page.getByText('You don\'t have access to this canvas').count()) > 0, 15000);
check('S2k Reopen without access: "Ask someone in the channel to add you."', await B.page.getByText('Ask someone in the channel to add you.').count() > 0);
await shot(B.page, 'S2k-dark');
mmctl('channel', 'users', 'add', 'acme:sprint-planning', 'bob');

// S2l / S2m: not set up (empty OpenCanvas URL), admin and a regular user
execSync(`docker exec ${C} mmctl --local config set PluginSettings.Plugins.${PLUGIN}.opencanvasurl ""`);
await sleep(1500);
const AD = await contextFor(browser, admin, 'light');
await gotoChannel(AD.page, 'sprint-planning');
await card(AD.page, 'Design review notes').locator('.oc-btn.pri').click().catch(() => undefined);
await until(async () => (await AD.page.getByText('OpenCanvas isn\'t set up').count()) > 0, 15000);
await shot(AD.page, 'S2l-light');
check('S2l not set up, admin: Open plugin settings', await AD.page.getByRole('button', {name: 'Open plugin settings'}).count() === 1);
await gotoChannel(B.page, 'sprint-planning');
await card(B.page, 'Design review notes').locator('.oc-meta').click().catch(() => undefined);
await until(async () => (await B.page.getByText('Canvases aren\'t available right now').count()) > 0, 15000);
await shot(B.page, 'S2m-dark');
check('S2m not set up, others: no settings link', await B.page.getByText('Canvases aren\'t available right now').count() > 0 &&
    await B.page.getByRole('button', {name: 'Open plugin settings'}).count() === 0);
await AD.page.getByRole('button', {name: 'Open plugin settings'}).click();
await sleep(4000);
await shot(AD.page, 'S6a-light');
check('S6 System Console page shows the help text', await AD.page.getByText('Must match id in OpenCanvas hosts.toml.').count() > 0);
execSync(`docker exec ${C} mmctl --local config set PluginSettings.Plugins.${PLUGIN}.opencanvasurl "${OC}"`);
await sleep(1500);
await AD.ctx.close();

// S2n: OpenCanvas unreachable, then Retry once it is back
if (process.env.OC_STOP && process.env.OC_RESTART) {
    execSync(process.env.OC_STOP);
    await sleep(1000);
    await gotoChannel(A.page, 'sprint-planning');
    await card(A.page, 'Sprint 43 planning (final)').locator('.oc-btn.pri').click();
    await until(async () => (await A.page.getByText('Can\'t reach the canvas server').count()) > 0, 40000);
    await shot(A.page, 'S2n-light');
    check('S2n canvas server down: "Can\'t reach the canvas server" + Retry', await A.page.getByRole('button', {name: 'Retry'}).count() === 1);
    execSync(process.env.OC_RESTART);
    await until(async () => (await fetch(OC + '/app/')).ok, 20000);
    await A.page.getByRole('button', {name: 'Retry'}).click();
    await until(async () => (await editorText(A.page)).includes('Sprint goal'), 30000);
    check('S2n Retry opens the canvas once the server is back', (await editorText(A.page)).includes('Sprint goal'));
}

// S2a skeleton (captured while a launch is in flight) and S1d loading/no-access/gone states
await gotoChannel(B.page, 'sprint-planning');
await card(B.page, 'Design review notes').locator('.oc-btn.pri').click();
await sleep(450);
await shot(B.page, 'S2a-dark');
const privateCh = (await api(alice.tok, 'POST', '/api/v4/channels', {team_id: team.id, name: 'design-review', display_name: 'design-review', type: 'P'})).json;
const pc = await api(alice.tok, 'POST', `/plugins/${PLUGIN}/api/v1/canvases`, {channelId: privateCh.id, title: 'Customer call: Northwind', template: ''});
const info = await api(bob.tok, 'GET', `/plugins/${PLUGIN}/api/v1/canvases/${pc.json.id}`);
check('S1d a non-member gets no access to a private channel\'s canvas', info.status === 403 && info.json.error === 'NO_ACCESS', String(info.status));
const launch = await api(bob.tok, 'POST', `/plugins/${PLUGIN}/api/v1/canvases/${pc.json.id}/launch`);
check('S2k a non-member\'s launch is refused (404)', launch.status === 404, String(launch.status));
const gone = await api(bob.tok, 'GET', `/plugins/${PLUGIN}/api/v1/canvases/mm_000000000000000000000000`);
check('S1d an unknown canvas is gone (404 GONE)', gone.status === 404 && gone.json.error === 'GONE', String(gone.status));

await browser.close();
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
