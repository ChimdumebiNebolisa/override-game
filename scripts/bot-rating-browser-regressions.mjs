import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { createInitialState } from '../src/shared/rules.ts';
import { sessionTokenId } from '../server/invitation-secrets.ts';

export async function runBotRatingRegressions({ browser, origin, outputDir, dbPath }) {
  const results = [];
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  async function screenshot(page, name) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No horizontal overflow');
    await page.screenshot({ path: resolve(outputDir, name + '.png'), fullPage: true });
  }
  async function contrast(locator) {
    const ratio = await locator.evaluate((element) => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d');
      const luminance = (color) => {
        ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
        const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
          const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
        });
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      const style = getComputedStyle(element); const foreground = luminance(style.color); const background = luminance(style.backgroundColor);
      return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
    });
    assert.ok(ratio >= 4.5, `Button contrast ${ratio.toFixed(2)} must be at least 4.5`);
    return ratio;
  }
  try {
    for (const width of [1440, 390, 320]) {
      const context = await browser.newContext({ viewport: { width, height: width === 320 ? 568 : 900 }, reducedMotion: 'reduce', isMobile: width < 400, hasTouch: width < 400 });
      await context.addInitScript(() => localStorage.setItem('override:welcome:v1', 'handled'));
      const token = randomBytes(32).toString('hex'); const uid = `rated-${width}`; const now = Date.now();
      db.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)').run(uid, uid, uid, now);
      db.prepare('INSERT INTO sessions (id, uid, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sessionTokenId(token), uid, now, now + 86400000);
      await context.addCookies([{ name: 'override_session', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
      const page = await context.newPage(); page.setDefaultTimeout(7000);
      const errors = []; page.on('pageerror', (error) => errors.push(error.message));
      const requests = []; page.on('request', (request) => requests.push(new URL(request.url()).pathname));
      try {
        if (width === 390) {
          let pending = true; let profileFailure = true;
          await page.route('**/api/matches/*/settlement', async route => {
            if (pending) { pending = false; await route.fulfill({ json: { settlement: null } }); }
            else await route.continue();
          });
          await page.route('**/api/profile/me', async route => {
            if (profileFailure) { profileFailure = false; await route.fulfill({ status: 503, json: { error: 'Temporary test outage' } }); }
            else await route.continue();
          });
        }
        await page.goto(origin);
        await page.locator('.hero h1').waitFor();
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.evaluate(() => document.fonts.check('700 24px "Roboto Condensed"')), true, 'The bundled display font loads on the local server');
        assert.equal((await page.request.get(origin + '/fonts/roboto-condensed-latin.woff2')).headers()['content-type'], 'font/woff2');
        const primaryColor = await page.locator('.hero-entry .primary-cta').evaluate((el) => getComputedStyle(el).backgroundColor);
        const secondaryColor = await page.locator('.hero-entry .secondary-cta').evaluate((el) => getComputedStyle(el).backgroundColor);
        assert.notEqual(primaryColor, secondaryColor);
        await contrast(page.locator('.hero-entry .primary-cta')); await contrast(page.locator('.hero-entry .secondary-cta'));
        for (const button of await page.locator('.site-header button').all()) {
          const bounds = await button.boundingBox();
          assert.ok(bounds.height >= 44 && bounds.width >= 44, 'Header controls must have 44px touch targets');
        }
        if (width < 400) {
          const cards = await page.locator('.mode-card').all();
          for (let i = 0; i < cards.length; i++) {
            const bounds = await cards[i].boundingBox();
            assert.ok(bounds.height >= 100 && bounds.height <= 150, 'Modes use compact readable rows on phones');
            if (i) assert.ok(bounds.y - (await cards[i - 1].boundingBox()).y - (await cards[i - 1].boundingBox()).height >= 12, 'Mode buttons have distinct touch spacing');
            assert.equal(await cards[i].evaluate(el => getComputedStyle(el).backgroundColor), secondaryColor);
          }
          assert.equal(await page.locator('.app-shell').evaluate(el => getComputedStyle(el).backgroundImage), 'none');
        }
        if (width === 1440) {
          const secondary = page.locator('.hero-entry .secondary-cta');
          await secondary.hover();
          assert.notEqual(await secondary.evaluate((el) => getComputedStyle(el).backgroundColor), secondaryColor);
          await page.mouse.down();
          assert.match(await secondary.evaluate((el) => getComputedStyle(el).filter), /brightness/);
          await page.mouse.move(0, 0); await page.mouse.up();
        }
        await screenshot(page, `rated-home-${width}`);
        await page.getByRole('button', { name: /^02 Quick Duel/ }).click();
        await page.getByRole('button', { name: /^Hard/ }).click();
        assert.equal(await page.locator('.difficulty-picker').getByRole('button', { pressed: true }).count(), 1);
        const normal = page.getByRole('button', { name: /^Normal/ });
        await normal.focus(); await page.keyboard.press('Space');
        assert.equal(await normal.getAttribute('aria-pressed'), 'true');
        await page.getByRole('button', { name: /^Hard/ }).focus(); await page.keyboard.press('Enter');
        assert.equal(await page.locator('.difficulty-picker').getByRole('button', { pressed: true }).count(), 1);
        await page.getByText('50% RP credit · 1000 RP bot', { exact: true }).waitFor();
        await page.locator('.panel-page > .primary-cta:not(:disabled)').waitFor();
        assert.equal(await page.getByRole('button', { name: /^Play Hard/ }).evaluate((el) => getComputedStyle(el).backgroundColor), primaryColor);
        await page.keyboard.press('Tab'); await page.getByRole('button', { name: /^Play Hard/ }).focus();
        assert.equal(await page.getByRole('button', { name: /^Play Hard/ }).evaluate((el) => getComputedStyle(el).outlineStyle), 'solid');
        await screenshot(page, `rated-setup-focus-${width}`);
        await page.getByRole('button', { name: /^Play Hard/ }).click();
        await page.locator('.match-credit-note').waitFor();
        if (width < 400) {
          const target = await page.locator('.board-panel .board-cell.legal').first().boundingBox();
          assert.ok(target.width >= 44 && target.height >= 44, 'Active board targets must be comfortable to tap');
          for (const name of ['Expand', 'Ambush', 'Surge', 'Pass']) {
            await page.locator('.action-grid button').filter({ hasText: new RegExp('^' + name) }).click();
            const lockBounds = await page.locator('.lock-button').boundingBox();
            assert.ok(lockBounds.y + lockBounds.height <= (width === 320 ? 568 : 900), `${name} and Lock remain visible in a rated mobile duel`);
          }
        }
        await screenshot(page, `rated-game-${width}`);
        await page.getByRole('button', { name: 'Leave match', exact: true }).click();
        await page.getByRole('dialog').filter({ hasText: 'Resign match?' }).waitFor();
        assert.ok((await page.getByRole('dialog').innerText()).includes('can lower your RP'));
        if (width < 400) {
          const warning = await page.getByRole('dialog').locator('p').boundingBox();
          assert.ok(warning.width > 200, 'The RP warning must wrap above the buttons on mobile');
        }
        await contrast(page.getByRole('button', { name: 'Resign', exact: true }));
        await screenshot(page, `rated-resign-${width}`);
        await page.getByRole('button', { name: 'Keep playing', exact: true }).click();
        let firstSide;
        for (let game = 0; game < 2; game++) {
          const response = await page.request.get(origin + '/api/resume'); const { match } = await response.json();
          if (game === 0) firstSide = match.player; else assert.notEqual(match.player, firstSide);
          const state = { ...createInitialState(), round: 12, energy: { A: 0, B: 0 }, board: Array(25).fill(match.player) };
          db.prepare('UPDATE matches SET state_json = ?, deadline = ?, revision = revision + 1 WHERE id = ?')
            .run(JSON.stringify(state), Date.now() + 120000, match.id);
          await page.reload(); await page.locator('.game-page').waitFor();
          await page.locator('.action-grid button').filter({ hasText: /^Pass/ }).click();
          await page.locator('.lock-button:not(:disabled)').waitFor();
          const lock = page.getByRole('button', { name: /^Lock move/ }); await contrast(lock);
          assert.equal(await lock.evaluate((el) => getComputedStyle(el).backgroundColor), primaryColor);
          await lock.click(); await page.locator('.settlement-card').waitFor();
          assert.match(await page.locator('.result-page > .eyebrow').textContent(), /Hard bot · RP duel/);
          assert.equal(await page.getByRole('button', { name: /^Request rematch/ }).count(), 0);
          if (game === 0) {
            assert.ok((await page.locator('.settlement-card').innerText()).includes('1/2'));
            assert.equal(await page.getByText('Rating', { exact: true }).count(), 0);
            await page.getByRole('button', { name: /^Rematch/ }).click(); await page.locator('.game-page').waitFor();
          }
        }
        assert.ok((await page.locator('.settlement-card').innerText()).includes('1031'));
        assert.ok((await page.locator('.result-page').innerText()).includes('W-L-D and streak stay unchanged'));
        assert.equal(requests.some((path) => /\/api\/ranked\/.*rematch/.test(path)), false);
        if (width === 390) {
          const immutableRequests = () => requests.filter(path => path.endsWith('/settlement') || path === '/api/profile/me').length;
          const beforeIdle = immutableRequests();
          await page.waitForTimeout(2500);
          assert.equal(immutableRequests(), beforeIdle, 'A committed bot result must stop polling settlement and profile');
        }
        await screenshot(page, `rated-result-${width}`);
        await page.getByRole('button', { name: 'Leaderboard', exact: true }).last().click();
        await page.getByRole('row').filter({ hasText: uid }).waitFor();
        assert.ok((await page.getByRole('row').filter({ hasText: uid }).innerText()).includes('1031'));
        await screenshot(page, `rated-leaderboard-${width}`);
        await page.locator('.profile-button').click(); await page.locator('.profile-stats').waitFor();
        await screenshot(page, `rated-profile-${width}`);
        assert.deepEqual(errors, []);
        results.push({ name: `rated-bot-placement-and-buttons-${width}`, passed: true, placementRating: 1031, bothSides: true });
      } catch (error) {
        await page.screenshot({ path: resolve(outputDir, `rated-bot-${width}-failure.png`), fullPage: true });
        results.push({ name: `rated-bot-placement-and-buttons-${width}`, passed: false, error: error.stack });
      } finally { await context.close(); }
    }
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(() => localStorage.setItem('override:welcome:v1', 'handled'));
    const page = await context.newPage();
    try {
      await page.goto(origin); await page.getByRole('button', { name: /^02 Quick Duel/ }).click();
      await page.getByRole('button', { name: /^Hard/ }).click(); await page.getByRole('button', { name: /Set up your profile/ }).waitFor();
      await screenshot(page, 'guest-hard-setup');
      await page.getByRole('button', { name: /^Play Hard/ }).click(); await page.locator('.game-page').waitFor();
      assert.equal(await page.locator('.match-credit-note').count(), 0);
      await page.getByRole('button', { name: 'Leave match', exact: true }).click();
      await page.getByRole('button', { name: 'Resign', exact: true }).click(); await page.locator('.result-page').waitFor();
      assert.equal(await page.locator('.settlement-card').count(), 0);
      results.push({ name: 'guest-hard-stays-unranked', passed: true });
    } catch (error) { results.push({ name: 'guest-hard-stays-unranked', passed: false, error: error.message }); }
    finally { await context.close(); }
    const recoveredContext = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    const uid = 'recovery-player'; const now = Date.now();
    const originalToken = randomBytes(32).toString('hex'); const replacementToken = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO profiles (uid, handle, normalized_handle, created_at) VALUES (?, ?, ?, ?)').run(uid, uid, uid, now);
    for (const token of [originalToken, replacementToken]) db.prepare('INSERT INTO sessions (id, uid, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sessionTokenId(token), uid, now, now + 86400000);
    const headers = { origin, 'x-requested-with': 'override-game' };
    await recoveredContext.addCookies([{ name: 'override_session', value: originalToken, url: origin, httpOnly: true, sameSite: 'Lax' }]);
    const original = await recoveredContext.request.post(origin + '/api/bot-matches', { headers, data: { mode: 'quick', difficulty: 'hard', creationKey: randomUUID() } });
    assert.equal(original.status(), 201, await original.text());
    const { match: lostMatch } = await original.json();
    db.prepare("UPDATE matches SET status = 'review', deadline = NULL WHERE id = ?").run(lostMatch.id);
    await recoveredContext.addCookies([{ name: 'override_session', value: replacementToken, url: origin, httpOnly: true, sameSite: 'Lax' }]);
    await recoveredContext.addInitScript(() => localStorage.setItem('override:welcome:v1', 'handled'));
    const recoveredPage = await recoveredContext.newPage();
    const recoveryErrors = []; recoveredPage.on('pageerror', error => recoveryErrors.push(error.message));
    try {
      await recoveredPage.goto(origin);
      await recoveredPage.getByRole('button', { name: 'End Hard duel' }).waitFor();
      await screenshot(recoveredPage, 'account-recovery-mobile');
      assert.equal((await recoveredPage.request.get(`${origin}/api/matches/${lostMatch.id}`)).status(), 404);
      await recoveredPage.getByRole('button', { name: 'End Hard duel' }).click();
      await recoveredPage.getByRole('button', { name: 'Resign', exact: true }).click();
      await recoveredPage.locator('.settlement-card').waitFor();
      await screenshot(recoveredPage, 'account-recovery-settled-mobile');
      assert.deepEqual(recoveryErrors, []);
      assert.equal(db.prepare('SELECT rating FROM profiles WHERE uid = ?').get(uid).rating, 984);
      const retry = await recoveredPage.request.post(`${origin}/api/bot-matches/${lostMatch.id}/resign`, { headers, data: { confirm: true } });
      assert.equal(retry.status(), 200);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM rating_settlements WHERE match_id = ?').get(lostMatch.id).count, 1);
      assert.equal((await recoveredPage.request.post(origin + '/api/bot-matches', { headers, data: { mode: 'quick', difficulty: 'hard', creationKey: randomUUID() } })).status(), 201);
      results.push({ name: 'account-recovery-mobile-and-idempotent-settlement', passed: true });
    } catch (error) { results.push({ name: 'account-recovery-mobile-and-idempotent-settlement', passed: false, error: error.stack }); }
    finally { await recoveredContext.close(); }
  } finally { db.close(); }
  await writeFile(resolve(outputDir, 'bot-rating-regressions.json'), JSON.stringify(results, null, 2));
  return results;
}
