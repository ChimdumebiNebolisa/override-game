import assert from 'node:assert/strict';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createInitialState, legalTargets, resolveRound } from '../src/shared/rules.ts';
import { guideScenario, resolveGuideScenario } from '../src/client/guide-scenarios.ts';

// Browser fixtures control response ordering, not client state or game rules.
export async function runBrowserRegressions({ browser, origin, outputDir }) {
  await mkdir(outputDir, { recursive: true });
  const results = [];
  async function test(name, run) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const first = resolveRound(createInitialState(), {
      A: { type: 'expand', target: 2 }, B: { type: 'expand', target: 13 },
    });
    let current = {
      id: '00000000-0000-4000-8000-000000000001', roomId: null, mode: 'practice',
      botDifficulty: 'easy', timed: false, player: 'A', playerNames: { A: 'Player', B: 'Bot' },
      state: first.state, score: first.score, status: 'review', policyVersion: 2, progression: 'review', revision: 2,
      deadline: null, serverNow: Date.now(), locked: false, lastResult: first,
      resultType: null, competitiveMultiplier: null,
    };
    const held = [];
    let toHold = 0;
    let delayedRevision = 3;
    let failAction = false;
    let newMatches = 1;
    const submitted = [];
    const snapshot = (value = current) => ({ ...structuredClone(value), serverNow: Date.now() });
    await page.routeWebSocket('**/api/live*', () => {});
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      let data = {};
      let status = 200;
      let heldResponse = false;
      if (path === '/api/config') data = { firebaseConfig: null };
      else if (path === '/api/session') data = { signedIn: false, profile: null };
      else if (path === '/api/resume') data = { match: null, room: null, rankedQueue: null, rankedChallenge: null };
      else if (path === '/api/bot-matches') {
        if (newMatches++ > 1) current = { ...current,
          id: `00000000-0000-4000-8000-${String(newMatches).padStart(12, '0')}`,
          state: createInitialState(), score: { A: 4, B: 4 }, status: 'decision', revision: 1,
          locked: false, lastResult: null, resultType: null,
        };
        data = { match: snapshot() };
      } else if (path.endsWith('/next')) {
        current = { ...current, status: 'decision', revision: 3, locked: false };
        if (toHold > 0) {
          toHold--; heldResponse = true;
          let release;
          const gate = new Promise((done) => { release = done; });
          const delayed = snapshot({ ...current, revision: delayedRevision });
          held.push({ release, delayed });
          await gate;
          data = { match: delayed };
        } else data = { match: snapshot() };
      } else if (path.endsWith('/actions')) {
        if (failAction) { status = 503; data = { error: 'Verification fixture: retry this move.' }; }
        else {
          submitted.push(request.postDataJSON());
          current = { ...current, locked: true };
          data = { match: snapshot() };
        }
      } else if (path.endsWith('/resign')) {
        current = { ...current, status: 'finished', resultType: 'resignation',
          state: { ...current.state, status: 'finished', winner: 'B', endingReason: 'resignation' },
          revision: current.revision + 1,
        };
        data = { match: snapshot() };
      } else if (path.startsWith('/api/matches/') && request.method() === 'GET') {
        data = { match: snapshot() };
      }
      await route.fulfill({ status, json: data, headers: { 'x-test-response': heldResponse ? 'delayed' : 'snapshot' } });
    });
    const fixture = {
      page, held, submitted,
      hold(count, revision) { toHold = count; delayedRevision = revision; },
      open(revision = 3) { current = { ...current, status: 'decision', revision, locked: false }; },
      failMoves() { failAction = true; },
      nextRound() {
        const result = resolveRound(current.state, { A: submitted.at(-1)?.action ?? { type: 'pass' }, B: { type: 'pass' } });
        current = { ...current, state: result.state, score: result.score,
          lastResult: result, locked: false, revision: current.revision + 1 };
      },
    };
    try {
      await page.goto(origin);
      await page.getByRole('button', { name: /^01 Practice/ }).click();
      const subscribed = page.waitForResponse((value) => value.url().includes('/api/matches/') && value.request().method() === 'GET');
      await page.getByRole('button', { name: /^Play Easy/ }).click();
      await subscribed;
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await page.getByRole('button', { name: /^Next round/ }).waitFor();
      const evidence = await run(fixture);
      assert.deepEqual(errors, [], 'No uncaught browser errors');
      results.push({ name, passed: true, ...evidence });
    } catch (error) {
      await page.screenshot({ path: resolve(outputDir, `${name}-failure.png`), fullPage: true });
      results.push({ name, passed: false, error: error.message, errors });
    } finally {
      for (const response of held) response.release();
      await context.close();
    }
  }

  for (const [name, copies, delayedRevision, currentRevision] of [
    ['delayed-continuation', 1, 3, 3],
    ['stale-continuation', 1, 2, 3],
    ['duplicate-continuation', 1, 3, 3],
  ]) await test(name, async (fixture) => {
    const { page, held, submitted } = fixture;
    fixture.hold(copies, delayedRevision);
    await page.getByRole('button', { name: /^Next round/ }).click();
    assert.equal(await page.getByRole('button', { name: /^Opening round/ }).isDisabled(), true, 'Duplicate Next requests are prevented while pending');
    const until = Date.now() + 5000;
    while (held.length !== copies && Date.now() < until) await new Promise((done) => setTimeout(done, 10));
    assert.equal(held.length, copies, 'Continuation requests are pending');
    fixture.open(currentRevision);
    await page.waitForFunction(() => document.querySelectorAll('.action-grid button')[4]?.disabled === false);
    const action = name === 'duplicate-continuation' ? { type: 'ambush', target: 8 } : { type: 'expand', target: 3 };
    if (action.type === 'ambush') await page.locator('.action-grid button').nth(1).click();
    await page.locator('.board-panel .board-cell').nth(action.target).click();
    const selected = await page.locator('.selection-line').innerText();
    assert.ok(selected.includes(action.type === 'ambush' ? 'Ambush D2' : 'Expand D1'));
    // Confirm the response was delivered and processed before making assertions.
    const response = page.waitForResponse((value) => value.headers()['x-test-response'] === 'delayed');
    held[0].release();
    await response;
    if (delayedRevision === currentRevision) await page.locator('.round-review').waitFor({ state: 'detached' });
    else await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await page.screenshot({ path: resolve(outputDir, `${name}-selected.png`) });
    assert.equal(await page.locator('.selection-line').innerText(), selected, 'Late response preserves selection');
    await page.getByRole('button', { name: /^Lock move/ }).click();
    await page.getByRole('button', { name: /^Move locked/ }).waitFor();
    assert.deepEqual(submitted[0].action, action);
    fixture.open(currentRevision);
    await page.waitForTimeout(2100);
    assert.equal(await page.locator('.selection-line').innerText(), selected);
    assert.equal(await page.getByRole('button', { name: /^Move locked/ }).isDisabled(), true);
    fixture.nextRound();
    await page.waitForFunction(() => document.querySelector('.match-header strong')?.textContent.includes('Round 3'));
    assert.match(await page.locator('.selection-line').innerText(), /Expand: choose a node/);
    assert.equal(await page.getByRole('button', { name: /^Lock move/ }).isDisabled(), true);
    return { selected, submitted: submitted[0], resetOnAuthoritativeRound: true };
  });

  await test('restart-and-rematch', async (fixture) => {
    const { page, held } = fixture;
    fixture.hold(1, 3);
    await page.getByRole('button', { name: /^Next round/ }).click();
    fixture.open();
    await page.waitForFunction(() => document.querySelectorAll('.action-grid button')[4]?.disabled === false);
    await page.locator('.board-cell').nth(3).click();
    await page.getByRole('button', { name: 'Restart Practice', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.match-header strong')?.textContent.includes('Round 1'));
    const oldResponse = page.waitForResponse((value) => value.headers()['x-test-response'] === 'delayed');
    held[0].release();
    await oldResponse;
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.match(await page.locator('.selection-line').innerText(), /Expand: choose a node/);
    await page.locator('.board-cell.legal').first().click();
    await page.getByRole('button', { name: 'Leave match' }).click();
    await page.getByRole('button', { name: 'Resign', exact: true }).click();
    await page.getByRole('button', { name: /^Rematch/ }).click();
    await page.locator('.game-page').waitFor();
    assert.match(await page.locator('.selection-line').innerText(), /Expand: choose a node/);
    assert.equal(await page.getByRole('button', { name: /^Lock move/ }).isDisabled(), true);
    return { restartReset: true, rematchReset: true };
  });

  for (const [width, height] of [[900, 640], [901, 640], [902, 640], [1100, 640], [901, 600], [720, 450]]) {
    await test(`scroll-controls-${width}x${height}`, async (fixture) => {
      const { page } = fixture;
      await page.setViewportSize({ width, height });
      fixture.open();
      await page.waitForFunction(() => document.querySelectorAll('.action-grid button')[4]?.disabled === false);
      const boardBefore = await page.locator('.board-panel').boundingBox();
      await page.getByRole('button', { name: 'Round result', exact: true }).click();
      await page.getByRole('button', { name: 'Show details', exact: true }).click();
      assert.equal(await page.locator('.coach-note').count(), 1, 'Hints remain present');
      assert.equal(await page.locator('.round-review').count(), 1, 'Result remains present');
      const boardDuring = await page.locator('.board-panel').boundingBox();
      assert.equal(boardDuring.width, boardBefore.width, 'Opening result does not resize the board');
      await page.keyboard.press('Escape');
      await page.locator('.board-cell').nth(3).click();
      const lock = page.getByRole('button', { name: /^Lock move/ });
      // Normal wheel scrolling, without forcing a click or moving the DOM.
      await page.mouse.move(width - 40, height - 80);
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(100);
      let box = await lock.boundingBox();
      assert.ok(box.y >= 0 && box.y + box.height <= height, `Full lock visible after scrolling: ${JSON.stringify(box)}`);
      await page.screenshot({ path: resolve(outputDir, `controls-${width}x${height}-expanded.png`) });
      await page.getByRole('button', { name: 'Round result', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'Show details', exact: true }).getAttribute('aria-expanded'), 'false');
      await page.keyboard.press('Escape');
      await page.mouse.move(width - 40, height - 80);
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(100);
      box = await lock.boundingBox();
      assert.ok(box.y >= 0 && box.y + box.height <= height, 'Collapsed result also permits scrolling to full control');
      await page.screenshot({ path: resolve(outputDir, `controls-${width}x${height}-collapsed.png`) });
      await page.mouse.move(width - 40, height - 80);
      await page.mouse.wheel(0, 1600);
      fixture.failMoves();
      await lock.click();
      await page.getByRole('alert').filter({ hasText: 'Verification fixture' }).waitFor();
      await page.waitForFunction(() => !document.querySelector('.lock-button').disabled);
      // Native keyboard focus must reveal the whole button even with an error and hints.
      await page.locator('.board-cell').nth(3).click();
      for (let index = 0; index < 40; index++) {
        if (await lock.evaluate((button) => button === document.activeElement)) break;
        await page.keyboard.press('Tab');
      }
      assert.equal(await lock.evaluate((button) => button === document.activeElement), true);
      box = await lock.boundingBox();
      assert.ok(box.y >= 0 && box.y + box.height <= height, `Keyboard focus brings full button into view: ${JSON.stringify(box)}`);
      const keyboardRequest = page.waitForResponse((value) => value.url().endsWith('/actions') && value.status() === 503);
      await page.keyboard.press('Enter');
      await keyboardRequest;
      await page.getByRole('alert').filter({ hasText: 'Verification fixture' }).waitFor();
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(100);
      box = await lock.boundingBox();
      assert.ok(box.y >= 0 && box.y + box.height <= height, 'Error content remains scrollable');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: resolve(outputDir, `controls-${width}x${height}-error-focus.png`) });
      return { viewport: [width, height], lock: box, pointerSubmission: true, keyboardSubmission: true };
    });
  }
  await writeFile(resolve(outputDir, 'browser-regressions.json'), JSON.stringify(results, null, 2));
  return results;
}

export async function runGuideRegressions({ browser, origin, outputDir, dbPath }) {
  const results = [];
  async function check(name, run, options = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(origin);
      const evidence = await run(page, context);
      assert.deepEqual(errors, []);
      results.push({ name, passed: true, ...evidence });
    } catch (error) {
      await page.screenshot({ path: resolve(outputDir, `${name}-failure.png`), fullPage: true });
      results.push({ name, passed: false, error: error.message, errors });
    } finally { await context.close(); }
  }
  for (const [width, height] of [[1440, 900], [1440, 640], [390, 844], [320, 568]]) {
    await check(`hero-centered-visual-${width}-${height}`, async (page) => {
      const hero = page.locator('.hero');
      const artwork = hero.locator('.hero-artwork');
      assert.equal(await artwork.getAttribute('aria-hidden'), 'true');
      assert.equal(await artwork.locator('button, select, input').count(), 0);
      assert.equal(await artwork.locator('svg').count(), 2);
      assert.equal(await hero.locator('.hero-demo').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const frame = await hero.boundingBox();
      const next = await page.locator('.mode-grid').boundingBox();
      assert.ok(next.y >= frame.y + frame.height, 'Hero does not overlap the following modes');
      const copy = await page.locator('.hero-copy').boundingBox();
      assert.ok(Math.abs(copy.x + copy.width / 2 - width / 2) <= 1, 'Hero content is centered');
      const start = await hero.getByRole('button', { name: /^Start a game/ }).boundingBox();
      const learn = await hero.getByRole('button', { name: /^Learn with a bot/ }).boundingBox();
      if (width >= 900) assert.equal(start.y, learn.y, 'Desktop actions share one aligned row');
      else assert.ok(learn.y >= start.y + start.height, 'Narrow actions stack without overlap');
      assert.ok(start.height >= 44 && learn.height >= 44, 'Both actions have clear tap targets');
      const background = await page.locator('body').evaluate((element) => {
        const probe = document.createElement('div');
        probe.style.backgroundColor = 'var(--paper)';
        element.append(probe);
        const paper = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { body: getComputedStyle(element).backgroundColor, paper };
      });
      assert.equal(background.body, background.paper, 'The light page background is preserved');
      await hero.getByRole('button', { name: /^Learn with a bot/ }).focus();
      assert.equal(await page.evaluate(() => document.activeElement.matches(':focus-visible')), true);
      await page.screenshot({ path: resolve(outputDir, `hero-centered-${width}-${height}.png`), fullPage: true });
      return { centered: true, lightBackground: true, pairedActions: true, noOverlap: true };
    }, { viewport: { width, height }, reducedMotion: 'reduce' });
  }
  const readMatch = async (page) => {
    const result = await page.request.get(`${origin}/api/resume`);
    assert.equal(result.status(), 200);
    return (await result.json()).match;
  };
  const dismissTraining = async (page) => {
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const button = page.getByRole('button', { name: /^Got it/ });
    if (await button.count()) await button.click();
  };
  const boardGeometry = (page) => page.locator('.board-panel').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y + scrollY, width: rect.width, height: rect.height };
  });
  const assertStableBoard = (actual, expected, message) => {
    for (const property of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(actual[property] - expected[property]) <= 1, `${message}: ${property} changed from ${expected[property]} to ${actual[property]}`);
    }
  };
  const lock = async (page, action = 'expand', keepSelection = false) => {
    await dismissTraining(page);
    if (action !== 'expand') await page.locator('.action-grid button').filter({ hasText: new RegExp(`^${action}`, 'i') }).click();
    await dismissTraining(page);
    if (action !== 'pass' && !keepSelection) await page.locator('.board-panel .board-cell.legal').first().click();
    await dismissTraining(page);
    const response = page.waitForResponse((item) => item.url().endsWith('/actions'));
    await page.getByRole('button', { name: /^Lock move/ }).click();
    const locked = await response;
    assert.equal(locked.status(), 200);
    if ((await locked.json()).match.status === 'finished') await page.locator('.result-page').waitFor();
    else await page.getByRole('heading', { name: /resolved/ }).waitFor();
  };
  const next = async (page) => {
    const response = page.waitForResponse((item) => item.url().endsWith('/next'));
    await page.getByRole('button', { name: /^Next round/ }).click();
    assert.equal((await response).status(), 200);
    await page.waitForFunction(() => document.querySelectorAll('.action-grid button')[4]?.disabled === false);
    await dismissTraining(page);
  };
  const learn = async (page, root = page) => {
    await root.getByRole('button', { name: /Learn with a bot/ }).click();
    await page.locator('.game-page').waitFor();
    const match = await readMatch(page);
    assert.equal(match.mode, 'practice'); assert.equal(match.botDifficulty, 'easy'); assert.equal(match.timed, false);
    assert.deepEqual(match.state, createInitialState());
    await page.getByRole('dialog', { name: 'Claim a space' }).waitFor();
    assert.equal((await page.getByRole('dialog').locator('p').innerText()).split(/[.!?]/).filter(Boolean).length, 1, 'Training starts with one sentence');
    await dismissTraining(page);
    return match;
  };
  const friendForm = async (page) => {
    await page.getByRole('button', { name: /^02 Quick Duel/ }).click();
    await page.getByRole('button', { name: 'Play a friend', exact: true }).click();
  };
  for (const [width, height] of [[1440, 900], [390, 844], [320, 568]]) {
    await check(`ambush-learning-copy-and-layout-${width}`, async (page) => {
      await learn(page);
      const before = await boardGeometry(page);
      await page.locator('.action-grid button').filter({ hasText: /^Ambush/ }).click();
      const popup = page.getByRole('dialog', { name: 'Ambush', exact: true });
      await popup.waitFor();
      const copy = await popup.innerText();
      for (const phrase of ['capture that space', 'up to 3 Energy', 'drain up to 2', 'miss: −1', 'Requires 1 Energy']) assert.ok(copy.includes(phrase), phrase);
      assertStableBoard(await boardGeometry(page), before, 'Ambush tutorial keeps the board in place');
      assert.equal(await popup.evaluate(el => el.scrollWidth <= el.clientWidth), true);
      await page.screenshot({ path: resolve(outputDir, `ambush-learning-${width}.png`) });
      await dismissTraining(page);
      assert.ok((await page.locator('.selected-action-help').innerText()).includes('hit captures; miss −1'));
      await page.getByRole('button', { name: 'Action rules', exact: true }).click();
      const help = page.getByRole('dialog', { name: 'Action rules', exact: true });
      await help.waitFor();
      assert.ok((await help.innerText()).includes('Hit: capture that space'));
      assert.ok((await help.innerText()).includes('earn 0.5 Energy'));
      assertStableBoard(await boardGeometry(page), before, 'Full action rules keep the board in place');
      return { captureRule: true, energyRules: true, stableBoard: true };
    }, { viewport: { width, height }, reducedMotion: 'reduce' });
  }
  await check('uncertain-room-creation-recovers-original-options', async (page) => {
    await friendForm(page);
    await page.getByLabel('Display name', { exact: true }).fill('Original host');
    let acceptedId;
    const attempts = [];
    await page.route('**/api/rooms', async (route) => {
      attempts.push(route.request().postDataJSON());
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      acceptedId = (await response.json()).room.id;
      await route.abort('failed');
    }, { times: 1 });
    await page.locator('.room-form .primary-cta').click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByLabel('Display name', { exact: true }).isDisabled(), true, 'Lost accepted room response must freeze its original name');
    for (const name of ['Create room', 'Join room']) assert.equal(await page.locator('.segmented').getByRole('button', { name, exact: true }).isDisabled(), true);
    assert.ok((await page.getByRole('alert').innerText()).includes('Retry to recover this same room'));
    await page.locator('.room-form .primary-cta').click();
    await page.locator('.room-ticket > strong').waitFor();
    const resumed = (await (await page.request.get(`${origin}/api/resume`)).json()).room;
    assert.equal(resumed.id, acceptedId);
    assert.equal(resumed.hostDisplayName, 'Original host');
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(dbPath);
    try { assert.equal(db.prepare('SELECT count(*) AS count FROM rooms WHERE creation_key = ?').get(attempts[0].creationKey).count, 1); }
    finally { db.close(); }
    return { originalRoomRecovered: true };
  }, { viewport: { width: 390, height: 844 } });

  await check('uncertain-room-join-recovers-original-options', async (page) => {
    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await friendForm(page); await page.getByLabel('Display name', { exact: true }).fill('Host');
      await page.locator('.room-form .primary-cta').click(); await page.locator('.room-ticket > strong').waitFor();
      const code = await page.locator('.room-ticket > strong').innerText();
      await guest.goto(origin); await friendForm(guest);
      await guest.getByRole('button', { name: 'Join room', exact: true }).click();
      await guest.getByLabel('Display name', { exact: true }).fill('Original guest');
      await guest.getByLabel('Room code', { exact: true }).fill(code);
      await guest.route('**/api/rooms/join', async (route) => {
        const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed');
      }, { times: 1 });
      await guest.locator('.room-form .primary-cta').click(); await guest.getByRole('alert').waitFor();
      assert.equal(await guest.getByLabel('Display name', { exact: true }).isDisabled(), true);
      assert.equal(await guest.getByLabel('Room code', { exact: true }).isDisabled(), true);
      await guest.locator('.room-form .primary-cta').click(); await guest.locator('.game-page').waitFor();
      assert.equal((await readMatch(guest)).id, (await readMatch(page)).id);
      return { joinedMatchRecovered: true };
    } finally { await guestContext.close(); }
  });

  for (const width of [1440, 390, 320]) await check(`clipboard-denied-${width}`, async (page) => {
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async () => { throw new Error('Clipboard permission denied by audit fixture'); } } }));
    await friendForm(page); await page.getByLabel('Display name', { exact: true }).fill('Clipboard host');
    await page.locator('.room-form .primary-cta').click(); await page.locator('.room-ticket > strong').waitFor();
    await page.getByRole('button', { name: 'Copy invite link', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Couldn’t copy' }).waitFor();
    const fallback = page.getByRole('textbox', { name: 'Invite link', exact: true });
    assert.ok((await fallback.inputValue()).startsWith(`${origin}/join/`));
    await fallback.focus();
    assert.equal(await fallback.evaluate((input) => input.selectionEnd - input.selectionStart === input.value.length), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(outputDir, `clipboard-fallback-${width}.png`), fullPage: true });
    return { manualCopyAvailable: true };
  }, { viewport: { width, height: width === 320 ? 568 : 900 } });

  await check('clipboard-success-is-announced', async (page) => {
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async (value) => { globalThis.__copiedInvite = value; } } }));
    await friendForm(page); await page.getByLabel('Display name', { exact: true }).fill('Clipboard host');
    await page.locator('.room-form .primary-cta').click(); await page.locator('.room-ticket > strong').waitFor();
    await page.getByRole('button', { name: 'Copy invite link', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Invite link copied' }).waitFor();
    assert.ok((await page.evaluate(() => globalThis.__copiedInvite)).startsWith(`${origin}/join/`));
    return { copyAnnounced: true };
  });

  await check('uncertain-creation-recovers-original-options', async (page) => {
    await page.getByRole('button', { name: /^01 Practice/ }).click();
    let acceptedId;
    const attempts = [];
    await page.route('**/api/bot-matches', async (route) => {
      attempts.push(route.request().postDataJSON());
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      acceptedId = (await response.json()).match.id;
      await route.abort('failed');
    }, { times: 2 });
    await page.getByRole('button', { name: /^Play Easy/ }).click();
    await page.getByRole('alert').filter({ hasText: 'Retry to recover this same match' }).waitFor();
    assert.equal(await page.getByRole('checkbox').isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: /^Hard/ }).isDisabled(), true);
    assert.deepEqual(attempts[0], attempts[1]);
    await page.getByRole('button', { name: /^Play Easy/ }).click();
    await page.locator('.game-page').waitFor();
    const match = await readMatch(page);
    assert.equal(match.id, acceptedId);
    assert.equal(match.timed, false);
    return { recoveredSameMatch: true, attempts: attempts.length };
  });
  await check('voided-bot-rematch-recovers', async (page) => {
    const match = await learn(page);
    const { openDatabase } = await import('../server/db.ts');
    const db = openDatabase(dbPath);
    try { db.prepare("UPDATE matches SET state_json = 'corrupt', deadline = ? WHERE id = ?").run(Date.now() - 1, match.id); }
    finally { db.close(); }
    await page.getByRole('heading', { name: 'Match voided', exact: true }).waitFor();
    const created = page.waitForResponse((response) => response.url().endsWith('/api/bot-matches'));
    await page.getByRole('button', { name: /^Rematch/ }).click();
    const response = await created;
    assert.equal(response.status(), 201);
    assert.equal(response.request().postDataJSON().parentMatchId, undefined);
    await page.locator('.game-page').waitFor();
    const replacement = await readMatch(page);
    assert.notEqual(replacement.id, match.id);
    assert.equal(replacement.timed, false);
    return { recovered: true };
  }, { viewport: { width: 390, height: 844 } });
  await check('mobile-timed-move-stays-in-view', async (page) => {
    await page.getByRole('button', { name: /^02 Quick Duel/ }).click();
    const friend = page.locator('.friend-entry');
    const divider = await friend.locator('span').boundingBox();
    const button = await friend.getByRole('button').boundingBox();
    const group = await friend.boundingBox();
    assert.ok(button.y > divider.y + divider.height);
    assert.ok(Math.abs(button.width - group.width) < 1);
    await page.getByRole('button', { name: /^Play Normal/ }).click();
    await page.locator('.game-page').waitFor();
    await page.locator('.action-grid button').filter({ hasText: 'Ambush' }).click();
    assert.match(await page.locator('.selected-action-help').innerText(), /hit captures; miss −1/);
    const move = page.getByRole('button', { name: /^Lock move/ });
    const rect = await move.boundingBox();
    assert.ok(rect.y >= 0 && rect.y + rect.height <= 568, `Lock fits the timed viewport: ${JSON.stringify(rect)}`);
    await page.locator('.board-panel .board-cell.legal').first().click();
    await move.click();
    await page.getByRole('button', { name: /^Next round/ }).waitFor();
    assert.equal(await page.evaluate(() => scrollY), 0, 'No scrolling between action, target, and Lock');
    assert.equal(await page.locator('.action-grid button:not(:disabled)').count(), 0, 'Review keeps controls in place but disabled');
    assert.equal(await page.locator('.lock-button').isDisabled(), true);
    return { noDecisionScrolling: true };
  }, { viewport: { width: 320, height: 568 }, reducedMotion: 'reduce' });
  for (const [width, height] of [[320, 568], [390, 844]]) {
    await check(`home-mode-card-clearance-${width}`, async (page) => {
      await page.locator('.ranked-card').waitFor();
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      assert.equal(await page.evaluate(() => scrollY + innerHeight >= document.documentElement.scrollHeight), true);
      const card = await page.locator('.ranked-card').boundingBox();
      assert.ok(card.y >= 0 && card.y + card.height <= height, 'The last mode card is fully reachable');
      assert.equal(await page.locator('.hero-entry').evaluate((element) => getComputedStyle(element).position), 'static', 'The hero actions stay in the hero and do not cover cards');
      return { lastCardReachable: true, noFixedEntryBar: true };
    }, { viewport: { width, height } });
  }
  await check('welcome-dismiss-and-return', async (page) => {
    assert.equal(await page.locator('dialog[open]').count(), 0);
    await page.getByRole('button', { name: /^Start a game/ }).click();
    await page.getByRole('dialog', { name: 'Your first move' }).waitFor();
    assert.equal(await readMatch(page), null, 'No match exists behind welcome');
    assert.equal(await page.evaluate(() => document.activeElement.textContent.includes('Learn with a bot')), true);
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    for (let index = 0; index < 6; index++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement.closest('dialog')), true); }
    await page.screenshot({ path: resolve(outputDir, 'entry-welcome.png') });
    await page.keyboard.press('Escape');
    await page.locator('dialog[open]').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement.textContent.includes('Start a game')), true);
    assert.equal(await page.evaluate(() => localStorage.getItem('override:core-loop:v1')), null);
    await page.getByRole('button', { name: /^Start a game/ }).click();
    await page.getByRole('heading', { name: 'Choose your rival.' }).waitFor();
    assert.equal(await page.locator('dialog[open]').count(), 0);
    return { focusTrap: true, focusRestoration: true, firstClickOnly: true };
  });
  await check('welcome-jump-to-duel', async (page) => {
    await page.getByRole('button', { name: /^Start a game/ }).click();
    await page.getByRole('button', { name: 'Jump into a duel' }).click();
    await page.getByRole('heading', { name: 'Choose your rival.' }).waitFor();
    assert.equal(await readMatch(page), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('override:welcome:v1')), 'handled');
  });
  await check('welcome-learn-and-rules-entry', async (page) => {
    await page.getByRole('button', { name: /^Start a game/ }).click();
    await learn(page, page.getByRole('dialog', { name: 'Your first move' }));
    assert.equal(await page.evaluate(() => localStorage.getItem('override:welcome:v1')), 'handled');
    assert.equal(await page.evaluate(() => localStorage.getItem('override:core-loop:v1')), null);
    await page.getByRole('button', { name: 'Leave match', exact: true }).click();
    await page.getByRole('button', { name: 'Resign', exact: true }).click();
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await page.getByRole('button', { name: 'How to play', exact: true }).click();
    await learn(page);
    assert.equal(await page.locator('dialog[open]').count(), 0);
  });
  for (const width of [1440, 720, 390, 320]) await check(`normal-learning-core-${width}`, async (page) => {
    const initial = await learn(page);
    const geometry = await boardGeometry(page);
    assert.equal(await page.locator('dialog[open]').count(), 0);
    const cells = page.locator('.board-panel .board-cell');
    const legal = legalTargets(initial.state, initial.player, 'expand');
    assert.deepEqual(await cells.evaluateAll((buttons) => buttons.flatMap((button, index) => button.disabled ? [] : [index])), legal);
    if (width === 390) await cells.nth(legal.at(-1)).tap();
    else { await cells.nth(legal.at(-1)).focus(); await page.keyboard.press('Space'); }
    await page.getByRole('dialog', { name: 'Lock your move' }).waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('dialog')), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('board-cell')), true, 'Popup restores the selected target focus');
    assert.equal((await readMatch(page)).state.round, 1, 'Selection does not commit');
    await page.screenshot({ path: resolve(outputDir, `learning-selected-${width}.png`), fullPage: true });
    await lock(page, 'expand', true);
    let match = await readMatch(page);
    assert.equal(match.status, 'review'); assert.equal(match.deadline, null);
    assert.equal(match.lastResult.outcomes[initial.player].action.target, legal.at(-1), 'Alternative legal target stays selected');
    assert.match(await page.locator('.match-header strong').innerText(), /Round 1.*Review/i);
    assert.equal(await page.locator('.lock-button').isDisabled(), true, 'Review keeps the move editor disabled');
    assert.equal(await page.locator('.action-grid button:not(:disabled)').count(), 0, 'Review keeps controls in place but disabled');
    assertStableBoard(await boardGeometry(page), geometry, 'Result overlay does not move or resize the board');
    await page.keyboard.press('Escape');
    assert.equal((await readMatch(page)).status, 'review', 'Closing feedback does not advance the round');
    assert.equal(await page.evaluate(() => localStorage.getItem('override:core-loop:v1')), null);
    await page.getByRole('button', { name: 'Round result', exact: true }).click();
    await page.getByRole('dialog', { name: 'Round 1 result' }).waitFor();
    assert.equal(await page.locator('.round-review .reveal-actions p').first().evaluate(el => getComputedStyle(el).display), 'block', 'Short outcome is visible, not hidden');
    const beforeReload = JSON.stringify(match.lastResult);
    await page.reload(); await page.getByRole('button', { name: /^Next round/ }).waitFor();
    assert.equal(JSON.stringify((await readMatch(page)).lastResult), beforeReload);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: resolve(outputDir, `learning-review-${width}.png`), fullPage: true });
    await next(page);
    assertStableBoard(await boardGeometry(page), geometry, 'Next round preserves board geometry');
    assert.equal(await page.locator('.learning-coach').count(), 0, 'Inline training is removed');
    assert.equal(await page.locator('.coach-note').count(), 0, 'No tactical hint on independent move');
    assert.equal(await page.locator('.suggested-target').count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('override:core-loop:v1')), null);
    await lock(page, 'pass');
    assert.ok((await page.locator('.round-review').innerText()).includes('You practiced the loop'));
    assert.equal(await page.locator('.round-review').getByRole('button', { name: /^Start a duel/ }).count(), 1);
    assert.equal(await page.evaluate(() => localStorage.getItem('override:core-loop:v1')), null, 'Second review still needs acknowledgement');
    await next(page);
    assert.equal(await page.evaluate(() => localStorage.getItem('override:core-loop:v1')), 'completed');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.reload(); await page.locator('.game-page').waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('override:core-loop:v1')), 'completed');
    await page.getByRole('button', { name: 'Replay learning', exact: true }).click();
    await page.getByRole('button', { name: 'Resign', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.match-header strong')?.textContent.includes('Round 1 /'));
    assert.equal(await page.evaluate(() => localStorage.getItem('override:core-loop:v1')), 'completed', 'Replay preserves earned completion');
    return { matchId: initial.id, legal, manualPassCompletion: true, resumeReview: true, keyboardBoard: width !== 390, touchBoard: width === 390 };
  }, { viewport: { width, height: width === 720 ? 450 : width === 320 ? 568 : width < 500 ? 844 : 900 }, hasTouch: width < 500, isMobile: width < 500, reducedMotion: 'reduce' });
  await check('accepted-lock-and-next-lost-responses', async (page) => {
    await learn(page);
    await page.route('**/api/matches/*/actions', async (route) => { await route.fetch(); await route.abort('failed'); });
    await page.locator('.board-panel .board-cell.legal').last().click();
    await page.getByRole('dialog', { name: 'Lock your move' }).waitFor();
    await dismissTraining(page);
    await page.getByRole('button', { name: /^Lock move/ }).click();
    await page.getByRole('button', { name: /^Next round/ }).waitFor();
    assert.equal((await readMatch(page)).status, 'review');
    assert.equal(await page.evaluate(() => localStorage.getItem('override:core-loop:v1')), null);
    await page.unroute('**/api/matches/*/actions');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Round result', exact: true }).click();
    await page.route('**/api/matches/*/next', async (route) => { await route.fetch(); await route.abort('failed'); });
    await page.getByRole('button', { name: /^Next round/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.action-grid button')[4]?.disabled === false);
    await page.getByRole('dialog', { name: 'Your turn' }).waitFor();
    await dismissTraining(page);
    assert.equal(await page.locator('.learning-coach').count(), 0, 'Inline training is removed');
    await page.unroute('**/api/matches/*/next');
    await lock(page, 'pass'); await next(page);
    assert.equal(await page.evaluate(() => localStorage.getItem('override:core-loop:v1')), 'completed');
  });
  await check('skip-and-replay-learning', async (page) => {
    const initial = await learn(page);
    await page.getByRole('button', { name: 'Action rules', exact: true }).click();
    await page.getByRole('button', { name: 'Skip coaching', exact: true }).click();
    await lock(page); await next(page); await lock(page, 'pass'); await next(page);
    assert.equal((await readMatch(page)).id, initial.id);
    assert.equal(await page.evaluate(() => localStorage.getItem('override:core-loop:v1')), null);
    await page.getByRole('button', { name: 'Replay learning', exact: true }).click();
    await page.getByRole('button', { name: 'Resign', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.match-header strong')?.textContent.includes('Round 1 /'));
    const replay = await readMatch(page);
    assert.notEqual(replay.id, initial.id);
    assert.equal(replay.timed, false);
    await page.getByRole('dialog', { name: 'Claim a space' }).waitFor();
  });
  await check('storage-unavailable-learning', async (page, context) => {
    await context.addInitScript(() => {
      Storage.prototype.getItem = function () { throw new Error('Storage unavailable'); };
      Storage.prototype.setItem = function () { throw new Error('Storage unavailable'); };
      Storage.prototype.removeItem = function () { throw new Error('Storage unavailable'); };
    });
    await page.reload(); await learn(page); await lock(page); await next(page); await lock(page, 'pass'); await next(page);
    assert.equal(await page.locator('.learning-coach').count(), 0);
  });
  await check('complete-bot-match', async (page) => {
    await page.getByRole('button', { name: /^01 Practice/ }).click();
    await page.getByRole('button', { name: /^Play Easy/ }).click();
    await page.locator('.game-page').waitFor();
    for (let round = 1; round <= 15; round++) {
      if (await page.locator('.result-page').count()) break;
      const canExpand = await page.locator('.board-panel .board-cell.legal:not(:disabled)').count();
      await lock(page, canExpand ? 'expand' : 'pass');
      if (await page.locator('.result-page').count()) break;
      await next(page);
    }
    await page.locator('.result-page').waitFor();
    assert.equal(await page.getByRole('button', { name: /^Next round/ }).count(), 0);
    await page.screenshot({ path: resolve(outputDir, 'bot-final-result.png'), fullPage: true });
    const result = await page.request.get(`${origin}/api/matches/${await page.evaluate(() => sessionStorage.getItem('override:current-match'))}`);
    assert.equal((await result.json()).match.status, 'finished');
    await page.getByRole('button', { name: /^Rematch/ }).click();
    await page.locator('.game-page').waitFor();
    assert.equal((await readMatch(page)).policyVersion, 2);
  });
  for (const mode of ['timed-practice', 'quick-bot']) await check(mode, async (page) => {
    await page.getByRole('button', { name: mode === 'timed-practice' ? /^01 Practice/ : /^02 Quick Duel/ }).click();
    if (mode === 'timed-practice') await page.getByRole('checkbox', { name: /Use a turn timer/ }).check();
    await page.getByRole('button', { name: /^Play (Easy|Normal|Hard)/ }).click();
    await page.locator('.game-page').waitFor();
    let match = await readMatch(page);
    assert.equal(match.deadline - match.serverNow <= 10_000 && match.deadline - match.serverNow > 8_000, true);
    assert.notEqual(await page.locator('.timer b').innerText(), '010');
    const clockDeadline = match.deadline;
    await page.getByRole('button', { name: 'Action rules', exact: true }).click();
    await page.getByRole('dialog', { name: 'Action rules' }).waitFor();
    assert.ok((await page.getByRole('dialog').innerText()).includes('The clock keeps running'));
    assert.equal((await readMatch(page)).deadline, clockDeadline, 'Opening help never resets the clock');
    await page.keyboard.press('Escape');
    await lock(page);
    match = await readMatch(page);
    assert.equal(match.status, 'review'); assert.equal(match.deadline, null);
    await page.waitForTimeout(11_000);
    assert.equal((await readMatch(page)).status, 'review', 'Idle review has no automatic progress');
    await next(page);
    match = await readMatch(page);
    assert.ok(match.deadline - match.serverNow > 8_000, 'Next opens a fresh full decision');
  });
  await check('rules-reference-and-zoom', async (page) => {
    await page.getByRole('button', { name: 'How to play', exact: true }).click();
    assert.equal(await page.locator('.learning-choices button').count(), 2);
    await page.getByRole('button', { name: 'Read the rules', exact: true }).focus(); await page.keyboard.press('Enter');
    const text = await page.locator('.rules-reference').innerText();
    for (const rule of ['Expand', 'Ambush', 'Override', 'Surge', 'Pass', 'Energy', 'sudden death', 'Selecting a space never locks', 'captures that space for you', 'full 5 Energy bar', '0.5 Energy', 'miss costs 1 Energy']) assert.ok(text.includes(rule));
    const mixed = resolveGuideScenario(guideScenario('surge', 'mixed'), { type: 'surge', target: 10, secondTarget: 13 });
    const board = await page.locator('.rule-examples figure').nth(1).locator('.board-cell').evaluateAll((buttons) => buttons.map((button) => /owner-(A|B|neutral)/.exec(button.className)[1]));
    assert.deepEqual(board, mixed.state.board);
    await page.setViewportSize({ width: 720, height: 450 }); // Equivalent CSS viewport to 200% zoom at 1440x900.
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(outputDir, 'rules-zoom-equivalent.png'), fullPage: true });
  });
  await check('two-independent-human-clients', async (page) => {
    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await page.getByRole('button', { name: /^02 Quick Duel/ }).click();
      await page.getByRole('button', { name: 'Play a friend', exact: true }).click();
      await page.getByLabel('Display name', { exact: true }).fill('Host');
      await page.locator('.room-form .primary-cta').click();
      await page.locator('.room-ticket > strong').waitFor();
      const code = await page.locator('.room-ticket > strong').innerText();
      await guest.goto(origin);
      await guest.getByRole('button', { name: /^02 Quick Duel/ }).click();
      await guest.getByRole('button', { name: 'Play a friend', exact: true }).click();
      await guest.getByRole('button', { name: 'Join room', exact: true }).click();
      await guest.getByLabel('Display name', { exact: true }).fill('Guest');
      await guest.getByLabel('Room code', { exact: true }).fill(code);
      await guest.locator('.room-form .primary-cta').click();
      await page.locator('.game-page').waitFor(); await guest.locator('.game-page').waitFor();
      const initial = await readMatch(page);
      for (const client of [page, guest]) await client.locator('.board-panel .board-cell.legal').first().click();
      const first = page.waitForResponse((item) => item.url().endsWith('/actions'));
      await page.getByRole('button', { name: /^Lock move/ }).click(); await first;
      await page.getByRole('button', { name: /^Move locked/ }).waitFor();
      assert.equal((await readMatch(guest)).lastResult, null);
      await page.reload(); await page.getByRole('button', { name: /^Move locked/ }).waitFor();
      assert.equal((await readMatch(page)).deadline, initial.deadline, 'Reload does not reset deadline');
      const second = guest.waitForResponse((item) => item.url().endsWith('/actions'));
      await guest.getByRole('button', { name: /^Lock move/ }).click(); await second;
      await page.locator('.round-notice').waitFor();
      const reveal = await readMatch(page);
      assert.equal(reveal.status, 'transition'); assert.equal(reveal.deadline, null);
      assert.equal(await page.getByRole('button', { name: /^Next round/ }).count(), 0);
      await page.waitForFunction(() => document.querySelector('.match-header strong')?.textContent.includes('Round 2 /'));
      const [hostNext, guestNext] = await Promise.all([readMatch(page), readMatch(guest)]);
      assert.equal(hostNext.deadline, guestNext.deadline);
      assert.ok(hostNext.deadline >= reveal.transitionAt + 10_000);
      assert.equal(await page.locator('.lock-button').isDisabled(), true);
      assert.equal(await page.locator('dialog[open]').count(), 0, 'Automatic rounds never steal focus with a modal');
      await page.getByRole('button', { name: 'Round result', exact: true }).click();
      await page.getByRole('dialog', { name: 'Round 1 result' }).waitFor();
      assert.ok((await page.getByRole('dialog').innerText()).includes('The clock keeps running'));
      await page.keyboard.press('Escape');
      await page.screenshot({ path: resolve(outputDir, 'human-round-two.png') });
      return { sharedDeadline: hostNext.deadline, revealDuration: reveal.transitionAt - reveal.serverNow, reloadLock: true };
    } finally { await guestContext.close(); }
  });
  // Terminal/sudden-death browser fixtures use the real shared resolver and persisted local rows.
  for (const round of [12, 13, 15]) await check(`terminal-fixture-${round}`, async (page) => {
    await learn(page);
    if (round === 12) { await lock(page); await next(page); }
    const initial = await readMatch(page);
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(dbPath);
    try {
      const state = { ...createInitialState(), round, phase: round > 12 ? 'sudden-death' : 'standard' };
      if (round !== 15) {
        state.board[2] = initial.player; state.board[7] = initial.player; state.board[10] = initial.player;
      }
      db.prepare('UPDATE matches SET state_json = ?, revision = revision + 1 WHERE id = ?').run(JSON.stringify(state), initial.id);
    } finally { db.close(); }
    await page.reload(); await page.locator('.game-page').waitFor();
    await lock(page, 'pass');
    const response = await page.request.get(`${origin}/api/matches/${initial.id}`);
    const actual = (await response.json()).match;
    assert.equal(actual.status, 'finished');
    await page.locator('.result-page').waitFor();
    assert.equal(await page.getByRole('button', { name: /^Next round/ }).count(), 0);
    await page.screenshot({ path: resolve(outputDir, `terminal-round-${round}.png`), fullPage: true });
    if (round === 12) {
      assert.equal(await page.evaluate(() => localStorage.getItem('override:core-loop:v1')), null);
      await page.getByRole('button', { name: 'Home', exact: true }).click();
      assert.equal(await page.evaluate(() => localStorage.getItem('override:core-loop:v1')), 'completed', 'Terminal exit acknowledges independent result');
    }
  });
  for (const [width, height] of [[1440, 900], [390, 844], [320, 568]]) {
    await check(`fractional-energy-${width}`, async (page) => {
      const initial = await learn(page);
      assert.deepEqual(initial.state.energy, { A: 5, B: 5 });
      const me = initial.player;
      const rival = me === 'A' ? 'B' : 'A';
      const state = createInitialState();
      state.board = Array.from({ length: 25 }, (_, index) => index === 11 ? me : index === 13 ? rival : 'neutral');
      state.energy = { [me]: 2.5, [rival]: 0.5 };
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(dbPath);
      try { db.prepare('UPDATE matches SET state_json = ?, revision = revision + 1 WHERE id = ?').run(JSON.stringify(state), initial.id); }
      finally { db.close(); }
      await page.reload(); await page.locator('.game-page').waitFor(); await dismissTraining(page);
      assert.equal(await page.locator('.energy-bar strong').innerText(), '2.5 / 5');
      assert.equal(await page.locator('.energy-bar i.charged').count(), 2);
      assert.equal(await page.locator('.energy-bar i.half-charged').count(), 1);
      assert.equal(await page.locator('.energy-bar i').count(), 5);
      assert.equal(await page.locator('.action-grid button').filter({ hasText: /^Surge/ }).isDisabled(), true);
      assert.equal(await page.locator('.action-grid button').filter({ hasText: /^Ambush/ }).isDisabled(), false);
      await page.screenshot({ path: resolve(outputDir, `fractional-energy-${width}.png`), fullPage: true });
      await lock(page);
      const resolved = await readMatch(page);
      assert.equal(resolved.lastResult.outcomes[me].energyEarned, 0.5);
      assert.equal(resolved.state.energy[me], 3);
      await page.reload(); await page.getByRole('button', { name: /^Next round/ }).waitFor();
      assert.equal((await readMatch(page)).state.energy[me], 3);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      return { startingEnergy: initial.state.energy, halfFilled: true, persistedExpandReward: true };
    }, { viewport: { width, height }, reducedMotion: 'reduce' });

    await check(`successful-ambush-defeat-${width}`, async (page) => {
      const initial = await learn(page);
      const me = initial.player;
      const rival = me === 'A' ? 'B' : 'A';
      const before = { ...createInitialState(), round: 12,
        board: Array.from({ length: 25 }, (_, index) => index < 10 ? me : index < 22 ? rival : 'neutral'),
        energy: { [me]: 5, [rival]: 2 },
      };
      const result = resolveRound(before, { [me]: { type: 'ambush', target: 23 }, [rival]: { type: 'expand', target: 23 } });
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(dbPath);
      try { db.prepare("UPDATE matches SET state_json = ?, last_result_json = ?, status = 'finished', result_type = 'standard', revision = revision + 1 WHERE id = ?")
        .run(JSON.stringify(result.state), JSON.stringify(result), initial.id); }
      finally { db.close(); }
      await page.reload(); await page.locator('.result-page').waitFor();
      assert.equal(await page.locator('.result-explanation').innerText(), 'Your Ambush captured a space, but they finished ahead, 12–11. The final territory score decides the winner.');
      assert.equal(await page.locator('.result-score').count(), 1);
      assert.equal(await page.locator('.result-page .round-review').count(), 0);
      assert.equal(await page.locator('.last-move-summary > strong').evaluate((el, side) => {
        const sample = document.createElement('span'); sample.style.color = side === 'A' ? 'var(--blue)' : 'var(--coral)';
        document.body.append(sample); const expected = getComputedStyle(sample).color; sample.remove();
        return getComputedStyle(el).color === expected;
      }, me), true, 'Last move uses the actual territory colour');
      assert.ok((await page.locator('.last-move-summary').innerText()).includes('Rival lost 2 Energy'));
      assert.ok((await page.locator('.last-move-summary').innerText()).includes('Energy was full'));
      assert.ok(await page.locator('.result-page h1').evaluate((el) => parseFloat(getComputedStyle(el).fontSize) <= 80));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: resolve(outputDir, `successful-ambush-defeat-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: 'View last round', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Last round', exact: true });
      await dialog.waitFor();
      assert.equal(await dialog.locator('.reveal-score, .reveal-winner').count(), 0);
      assert.ok((await dialog.innerText()).includes('Lost 2 Energy to Ambush'));
      assert.ok((await dialog.innerText()).includes('Blocked the Expand and captured the space'));
      assert.equal(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => !!document.activeElement.closest('dialog')), true);
      await page.screenshot({ path: resolve(outputDir, `last-round-dialog-${width}.png`), fullPage: true });
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'View last round');
      return { finalScore: result.score, correctlyExplained: true, focusRestored: true };
    }, { viewport: { width, height }, reducedMotion: 'reduce' });
  }
  await writeFile(resolve(outputDir, 'learning-regressions.json'), JSON.stringify(results, null, 2));
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { chromium } = await import('playwright');
  const workDir = await mkdtemp(resolve(tmpdir(), 'override-browser-'));
  const listener = createServer();
  await new Promise((done) => listener.listen(0, '127.0.0.1', done));
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), PUBLIC_ORIGIN: origin, DB_PATH: resolve(workDir, 'game.sqlite') };
  delete env.FIREBASE_WEB_CONFIG;
  const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  server.stdout.on('data', (chunk) => { logs += chunk; });
  server.stderr.on('data', (chunk) => { logs += chunk; });
  let browser;
  try {
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      try { if ((await fetch(`${origin}/api/health`)).status === 200) break; } catch { /* Server starting. */ }
      if (server.exitCode !== null) throw new Error(logs);
      await new Promise((done) => setTimeout(done, 100));
    }
    browser = await chromium.launch({ headless: true });
    const results = await runBrowserRegressions({ browser, origin,
      outputDir: resolve(process.env.BROWSER_EVIDENCE_DIR ?? 'output/verification/browser') });
    results.push(...await runGuideRegressions({ browser, origin,
      outputDir: resolve(process.env.BROWSER_EVIDENCE_DIR ?? 'output/verification/browser'), dbPath: env.DB_PATH }));
    for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.error ? `: ${result.error}` : ''}`);
    if (results.some((result) => !result.passed)) process.exitCode = 1;
  } finally {
    await browser?.close();
    server.kill();
    await new Promise((done) => server.exitCode !== null ? done() : server.once('exit', done));
    if (dirname(resolve(workDir)) !== resolve(tmpdir()) || !resolve(workDir).startsWith(resolve(tmpdir()) + sep + 'override-browser-')) {
      throw new Error('Refusing to remove an unexpected fixture directory');
    }
    await rm(workDir, { recursive: true, force: true });
  }
}
