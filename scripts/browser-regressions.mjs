import assert from 'node:assert/strict';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createInitialState, legalTargets, resolveRound } from '../src/shared/rules.ts';
import { GUIDE_LESSONS, guideScenario, resolveGuideScenario, SURGE_EXAMPLES } from '../src/client/guide-scenarios.ts';

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
      state: first.state, score: first.score, status: 'transition', revision: 2,
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
        if (toHold > 0) {
          toHold--;
          heldResponse = true;
          let release;
          const gate = new Promise((done) => { release = done; });
          const delayed = snapshot({ ...current, status: 'decision', revision: delayedRevision, locked: false });
          held.push({ release, delayed });
          await gate;
          data = { match: delayed };
        } else data = { match: snapshot() };
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
    ['duplicate-continuation', 2, 3, 3],
  ]) await test(name, async (fixture) => {
    const { page, held, submitted } = fixture;
    fixture.hold(copies, delayedRevision);
    for (let index = 0; index < copies; index++) await page.getByRole('button', { name: /^Next round/ }).click();
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
    if (copies === 2) {
      const duplicate = page.waitForResponse((value) => value.headers()['x-test-response'] === 'delayed');
      held[1].release();
      await duplicate;
      // A following same-round unlocked poll also must not unlock the committed move.
      fixture.open(currentRevision);
      await page.waitForTimeout(2100);
      assert.equal(await page.locator('.selection-line').innerText(), selected);
      assert.equal(await page.getByRole('button', { name: /^Move locked/ }).isDisabled(), true);
    }
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

export async function runGuideRegressions({ browser, origin, outputDir }) {
  await mkdir(outputDir, { recursive: true });
  const results = [];
  const examples = [
    ...GUIDE_LESSONS.filter((lesson) => !['surge', 'finish'].includes(lesson.id)).map((lesson) => ({ lesson: lesson.id })),
    ...SURGE_EXAMPLES.map((example) => ({ lesson: 'surge', surge: example.id })),
    ...['standard-win', 'sudden-lead', 'draw'].map((finish) => ({ lesson: 'finish', finish })),
  ];
  for (const width of [1440, 390]) for (const example of examples) {
    if (width === 390 && example.lesson !== 'surge') continue;
    const name = `guide-${example.lesson}-${example.surge ?? example.finish ?? 'default'}-${width}`;
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(origin);
      await page.getByRole('button', { name: 'How to play', exact: true }).click();
      // Read the reference through its keyboard-accessible tab, then return to the lesson.
      await page.getByRole('tab', { name: 'Learn by playing' }).focus();
      await page.keyboard.press('ArrowRight');
      const reference = await page.locator('.rules-reference').innerText();
      assert.ok(reference.includes('Select one space, then optionally select a second before locking; both are part of the same move.'));
      assert.ok(reference.includes('An Expand collision leaves the space empty and earns no Energy.'));
      await page.keyboard.press('ArrowLeft');
      await page.locator('.lesson-nav button').nth(GUIDE_LESSONS.findIndex((lesson) => lesson.id === example.lesson)).click();
      if (example.surge) await page.locator('.surge-examples button').nth(SURGE_EXAMPLES.findIndex((entry) => entry.id === example.surge)).click();
      if (example.finish) await page.locator('.surge-examples button').nth(['standard-win', 'sudden-lead', 'draw'].indexOf(example.finish)).click();
      const scenario = guideScenario(example.lesson, example.surge, example.finish);
      const type = example.lesson === 'finish' ? example.finish === 'draw' ? 'pass' : 'expand' : GUIDE_LESSONS.find((lesson) => lesson.id === example.lesson).action;
      const cells = page.locator('.lesson-card .board-cell');
      const legal = type === 'pass' ? [] : legalTargets(scenario.start, 'A', type);
      const displayedLegal = () => cells.evaluateAll((buttons) => buttons.flatMap((button, index) => button.disabled ? [] : [index]));
      assert.deepEqual(await displayedLegal(), legal, 'All and only engine-valid targets are selectable');
      if (type === 'surge') {
        await cells.nth(7).click();
        await cells.nth(13).focus();
        await page.keyboard.press('Space');
        assert.equal(await cells.nth(7).getAttribute('aria-pressed'), 'true');
        assert.equal(await cells.nth(13).getAttribute('aria-pressed'), 'true');
        assert.equal(await cells.nth(14).isDisabled(), true, 'First target does not extend pre-round range');
        assert.deepEqual(await displayedLegal(), legal);
        await cells.nth(5).click();
        assert.equal(await cells.nth(7).getAttribute('aria-pressed'), 'true');
        assert.equal(await cells.nth(13).getAttribute('aria-pressed'), 'false');
        await cells.nth(5).click();
        assert.equal(await page.locator('.lesson-selection span').textContent(), 'Selected · 1/2');
        assert.equal(await page.locator('.lesson-selection strong').textContent(), 'Surge C2');
        await page.getByRole('button', { name: 'Reset example', exact: true }).click();
      }
      const targets = type === 'pass' ? [] : type === 'surge'
        ? example.surge === 'single' ? [7, 13] : [...scenario.suggestedTargets]
        : [scenario.suggestedTargets?.[0] ?? legal[0]];
      const move = type === 'pass' ? { type } : { type, target: targets[0], ...(targets.length === 2 ? { secondTarget: targets[1] } : {}) };
      async function revealAndCheck(action) {
        await page.getByRole('button', { name: /^Lock move/ }).click();
        assert.equal(await cells.count(), 25);
        assert.deepEqual(await displayedLegal(), [], 'Locked move cannot be edited');
        await page.getByRole('button', { name: /^Reveal both moves/ }).click();
        const expected = resolveGuideScenario(scenario, action);
        const board = await cells.evaluateAll((buttons) => buttons.map((button) => /owner-(A|B|neutral)/.exec(button.className)[1]));
        assert.deepEqual(board, expected.state.board, 'Displayed captures match shared resolver');
        const outcome = await page.locator('.lesson-outcome').innerText();
        assert.ok(outcome.includes(`Score · You ${expected.score.A} — Rival ${expected.score.B}`));
        assert.ok(outcome.includes(`Energy · ${scenario.start.energy.A} → ${expected.state.energy.A} / 3`));
        if (type === 'surge') assert.ok(outcome.includes('3 Energy total'));
        return outcome;
      }
      for (const target of targets) await cells.nth(target).click();
      if (type === 'surge') {
        assert.equal(await page.locator('.lesson-selection span').textContent(), 'Selected · 2/2');
        await page.screenshot({ path: resolve(outputDir, `${name}-two-selected.png`), fullPage: true });
      }
      const outcome = await revealAndCheck(move);
      await page.screenshot({ path: resolve(outputDir, `${name}-result.png`), fullPage: true });
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      assert.equal(await page.locator('.lesson-card .board-cell[aria-pressed="true"]').count(), 0);
      assert.deepEqual(await displayedLegal(), legal, 'Retry restores pre-round legal set');
      if (type === 'surge') {
        await cells.nth(7).click();
        await revealAndCheck({ type: 'surge', target: 7 });
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      results.push({ name, passed: true, legal, move, outcome, retry: true });
    } catch (error) {
      await page.screenshot({ path: resolve(outputDir, `${name}-failure.png`), fullPage: true });
      results.push({ name, passed: false, error: error.message, errors });
    } finally { await context.close(); }
  }
  await writeFile(resolve(outputDir, 'guide-regressions.json'), JSON.stringify(results, null, 2));
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
      outputDir: resolve(process.env.BROWSER_EVIDENCE_DIR ?? 'output/verification/browser') }));
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
