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
    await page.waitForFunction(() => !document.querySelectorAll('.action-grid button')[4].disabled);
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
    await page.waitForFunction(() => !document.querySelectorAll('.action-grid button')[4].disabled);
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
      await page.waitForFunction(() => !document.querySelectorAll('.action-grid button')[4].disabled);
      await page.getByRole('button', { name: 'Show details', exact: true }).click();
      assert.equal(await page.locator('.coach-note').count(), 1, 'Hints remain present');
      assert.equal(await page.locator('.round-review').count(), 1, 'Result remains present');
      await page.locator('.board-cell').nth(3).click();
      const lock = page.getByRole('button', { name: /^Lock move/ });
      // Normal wheel scrolling, without forcing a click or moving the DOM.
      await page.mouse.move(width - 40, height - 80);
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(100);
      let box = await lock.boundingBox();
      assert.ok(box.y >= 0 && box.y + box.height <= height, `Full lock visible after scrolling: ${JSON.stringify(box)}`);
      await page.screenshot({ path: resolve(outputDir, `controls-${width}x${height}-expanded.png`) });
      await page.getByRole('button', { name: 'Hide details', exact: true }).click();
      await page.mouse.move(width - 40, height - 80);
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(100);
      box = await lock.boundingBox();
      assert.ok(box.y >= 0 && box.y + box.height <= height, 'Collapsed result also permits scrolling to full control');
      await page.screenshot({ path: resolve(outputDir, `controls-${width}x${height}-collapsed.png`) });
      await page.getByRole('button', { name: 'Show details', exact: true }).click();
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
      assert.ok(box.y >= 0 && box.y + box.height <= height, 'Keyboard focus brings full button into view');
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
  const readMatch = async (page) => {
    const result = await page.request.get(`${origin}/api/resume`);
    assert.equal(result.status(), 200);
    return (await result.json()).match;
  };
  const lock = async (page, action = 'expand', keepSelection = false) => {
    if (action !== 'expand') await page.locator('.action-grid button').filter({ hasText: new RegExp(`^${action}`, 'i') }).click();
    if (action !== 'pass' && !keepSelection) await page.locator('.board-panel .board-cell.legal').first().click();
    const response = page.waitForResponse((item) => item.url().endsWith('/actions'));
    await page.getByRole('button', { name: /^Lock move/ }).click();
    assert.equal((await response).status(), 200);
    await page.getByRole('heading', { name: /resolved/ }).waitFor();
  };
  const next = async (page) => {
    const response = page.waitForResponse((item) => item.url().endsWith('/next'));
    await page.getByRole('button', { name: /^Next round/ }).click();
    assert.equal((await response).status(), 200);
    await page.waitForFunction(() => !document.querySelectorAll('.action-grid button')[4].disabled);
  };
  const learn = async (page, root = page) => {
    await root.getByRole('button', { name: /Learn with a bot/ }).click();
    await page.locator('.game-page').waitFor();
    const match = await readMatch(page);
    assert.equal(match.mode, 'practice'); assert.equal(match.botDifficulty, 'easy'); assert.equal(match.timed, false);
    assert.deepEqual(match.state, createInitialState());
    return match;
  };
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
    assert.equal(await page.locator('dialog[open]').count(), 0);
    const cells = page.locator('.board-panel .board-cell');
    const legal = legalTargets(initial.state, initial.player, 'expand');
    assert.deepEqual(await cells.evaluateAll((buttons) => buttons.flatMap((button, index) => button.disabled ? [] : [index])), legal);
    if (width === 390) await cells.nth(legal.at(-1)).tap();
    else { await cells.nth(legal.at(-1)).focus(); await page.keyboard.press('Space'); }
    assert.equal((await readMatch(page)).state.round, 1, 'Selection does not commit');
    await page.screenshot({ path: resolve(outputDir, `learning-selected-${width}.png`), fullPage: true });
    await lock(page, 'expand', true);
    let match = await readMatch(page);
    assert.equal(match.status, 'review'); assert.equal(match.deadline, null);
    assert.equal(match.lastResult.outcomes[initial.player].action.target, legal.at(-1), 'Alternative legal target stays selected');
    assert.match(await page.locator('.match-header strong').innerText(), /Round 1 resolved/i);
    assert.equal(await page.getByRole('button', { name: /^Lock move/ }).isDisabled(), true);
    const beforeReload = JSON.stringify(match.lastResult);
    await page.reload(); await page.getByRole('button', { name: /^Next round/ }).waitFor();
    assert.equal(JSON.stringify((await readMatch(page)).lastResult), beforeReload);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: resolve(outputDir, `learning-review-${width}.png`), fullPage: true });
    await next(page);
    assert.ok((await page.locator('.learning-coach').innerText()).includes('Choose your own move'));
    assert.equal(await page.locator('.coach-note').count(), 0, 'No tactical hint on independent move');
    assert.equal(await page.locator('.suggested-target').count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('override:core-loop:v1')), null);
    await lock(page, 'pass');
    assert.ok((await page.locator('.learning-coach').innerText()).includes('You practiced the loop'));
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
  }, { viewport: { width, height: width === 720 ? 450 : width < 500 ? 844 : 900 }, hasTouch: width < 500, isMobile: width < 500, reducedMotion: 'reduce' });
  await check('accepted-lock-and-next-lost-responses', async (page) => {
    await learn(page);
    await page.route('**/api/matches/*/actions', async (route) => { await route.fetch(); await route.abort('failed'); });
    await page.locator('.board-panel .board-cell.legal').last().click();
    await page.getByRole('button', { name: /^Lock move/ }).click();
    await page.getByRole('button', { name: /^Next round/ }).waitFor();
    assert.equal((await readMatch(page)).status, 'review');
    assert.equal(await page.evaluate(() => localStorage.getItem('override:core-loop:v1')), null);
    await page.unroute('**/api/matches/*/actions');
    await page.route('**/api/matches/*/next', async (route) => { await route.fetch(); await route.abort('failed'); });
    await page.getByRole('button', { name: /^Next round/ }).click();
    await page.waitForFunction(() => !document.querySelectorAll('.action-grid button')[4].disabled);
    assert.ok((await page.locator('.learning-coach').innerText()).includes('Choose your own move'));
    await page.unroute('**/api/matches/*/next');
    await lock(page, 'pass'); await next(page);
    assert.equal(await page.evaluate(() => localStorage.getItem('override:core-loop:v1')), 'completed');
  });
  await check('skip-and-replay-learning', async (page) => {
    const initial = await learn(page);
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
    assert.ok((await page.locator('.learning-coach').innerText()).includes('Try Expand'));
  });
  await check('storage-unavailable-learning', async (page, context) => {
    await context.addInitScript(() => {
      Storage.prototype.getItem = function () { throw new Error('Storage unavailable'); };
      Storage.prototype.setItem = function () { throw new Error('Storage unavailable'); };
      Storage.prototype.removeItem = function () { throw new Error('Storage unavailable'); };
    });
    await page.reload(); await learn(page); await lock(page); await next(page); await lock(page, 'pass'); await next(page);
    assert.equal(await page.locator('.learning-coach').count(), 1);
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
    for (const rule of ['Expand', 'Ambush', 'Override', 'Surge', 'Pass', 'Energy', 'sudden death', 'Selecting a space never locks']) assert.ok(text.includes(rule));
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
      await page.getByRole('heading', { name: 'Round 1 resolved.' }).waitFor();
      const reveal = await readMatch(page);
      assert.equal(reveal.status, 'transition'); assert.equal(reveal.deadline, null);
      assert.equal(await page.getByRole('button', { name: /^Next round/ }).count(), 0);
      await page.waitForFunction(() => document.querySelector('.match-header strong')?.textContent.includes('Round 2 /'));
      const [hostNext, guestNext] = await Promise.all([readMatch(page), readMatch(guest)]);
      assert.equal(hostNext.deadline, guestNext.deadline);
      assert.ok(hostNext.deadline >= reveal.transitionAt + 10_000);
      assert.equal(await page.locator('.lock-button').isDisabled(), true);
      assert.equal(await page.locator('.round-review').count(), 1, 'Compact previous result persists');
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
