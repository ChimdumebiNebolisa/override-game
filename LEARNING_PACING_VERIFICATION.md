# Learning and pacing verification / release handoff

Date: 2026-10-11. Branch: **codex/learning-round-pacing**, based on 1238ec10725d58982fe339fd4c07017bc3af5c38. Application commit **b840699c718e37d8809eb7a197dff89712d3f520** was pushed and deployed after the owner's explicit authorization. Existing unrelated output work was preserved.

## Authorized production rollout — 2026-10-11

Ran `npm run deploy:worker` against the configured default production Worker. Cloudflare version **35350bcf-76fa-4268-ac10-e6fcfe2d01a2** serves [the production game](https://override-game.cnebolisa.workers.dev/). No staging flag, namespace change, secret change or production fixture was used. The existing production recovery-control token was unavailable locally, so no pre-rollout recovery bookmark was collected; this did not change the additive migration or existing recovery mechanism.

Read-only verification confirmed HTTP 200, `health.ok === true`, matching HTML asset references and byte-for-byte SHA-256 equality for every built asset. The deployed main client is `index-CdL0ZJ2F.js` and stylesheet is `index-BAIMicxe.css`.

Four real production Chromium checks passed in fresh browser contexts: welcome/rules (no hidden match, keyboard focus containment, Escape restoration, exactly two learning choices); normal Easy untimed learning at 390 px (normal opening, editable alternative target, immediate Lock review, persisted review after reload and eleven seconds idle, independent manual Pass, explicit completion acknowledgement, replay availability and no horizontal overflow); timed Practice; and Quick bot. Both timed paths returned policy 2, a fresh ten-second decision, stationary review with no deadline after eleven seconds idle, and a fresh full window after authenticated Next. All three temporary games were explicitly resigned and active-match lookup returned null afterward. No uncaught browser errors occurred.

Deployment output and asset/flow evidence are local under `output/learning-production-*.log` and `output/playwright/production-learning/`. Later documentation-only commits record this rollout; the application source deployed remains the commit above.

## Production reference inspected

Inspected the real [production game](https://override-game.cnebolisa.workers.dev/): Home, generic Start a game, Quick selection, How to play, and Easy untimed Practice. Generic start went straight to Quick selection; How to play had six staged lessons and a separate reveal control. Selecting D3 did not commit; accepted Lock immediately revealed human Expand D3 and bot Expand C2, with scores 5–5. The next decision opened automatically and the header said round 2 while round 1's recap remained. The inspection match was explicitly resigned afterward. No public Ranked activity, production race/AFK/migration fixtures, or deployment was created. The deployed commit is not exposed by the UI; these observations do not establish that production equals local HEAD. Staging was not used as product reference or proof.

## Verification

Browser scripts use temporary Node SQLite databases, independent browser contexts and the built client. Worker smoke uses disposable Wrangler storage in Linux.

| Check | Result |
| --- | --- |
| npm test | 302 tests across 31 files |
| npm run build | TypeScript and Vite production build |
| npm run test:browser | 28 checks: 10 retained control/transport regressions and 18 real local entry/game/rules checks |
| npm run test:worker-runtime | Native Linux workerd/Wrangler: persistent sessions/review across restart, migrations, alarm deadline, socket transitions, Quick rematch/retry/side swap, Next authorization and retries against later reviews, SQL ledger |
| Linux Worker/Ranked/policy/adapter Vitest | 67 tests across 4 files, isolated Linux source copy |
| Dependency audits | Production and full audit: zero vulnerabilities |
| Container gate | Current Dockerfile build, health, persistent database, fixture, backup, restore, one session preserved and replayed settlement unchanged |
| Diff check | git diff --check |

Windows and WSL Ubuntu use Node 24.14.1. The repository's Linux-only runtime smoke was run on Linux; its Windows runtime limitation did not prevent verification. The disposable container uses port 9877 and volume override-learning-verify-data, removed after testing. Raw logs remain at output/learning-*.log; representative screenshots and browser reports are checked in under docs/learning-pacing-evidence/.

## Acceptance audit

| Brief acceptance | Implementation and actual check |
| --- | --- |
| 1 — creation and compatibility | Policy, rooms, Ranked, Quick rematch and matches tests cover first/later windows, restarts/rematches and legacy shell activation. Old-file Node and pre-policy Worker SQL adapter fixtures preserve decision/transition/grace/readying boards, deadlines and pending moves through migration/reinitialization. |
| 2 — immediate bot / fairness | Real accepted browser Lock resolves immediately. Policy tests vary valid current human commitments while asserting identical existing public-board/history/difficulty/seed bot output. Bot reasoning and shared mechanics were not changed. |
| 3 — private locks / races / settlement | One lock leaves the rival public view unchanged; both locks resolve once. Deadline-first and second-lock-first linearizations, exact-deadline rejection with committed due resolution, automatic Pass and duplicate/stale commands are regressions. Concurrent Worker terminal Ranked requests (two locks and duplicate) yield 200/200/409, one result, one settlement and one rated match per profile after alarm retry. |
| 4 — review / authenticated Next | Review has null deadline/transition, no due work or review strikes, and remains active/resumable. Worker restart, idle/refreshed review, invalid participant, fresh terminal/PvP/legacy acknowledgement rejection, immediate duplicate and old retry against a later review are checked. |
| 5 — reveal and endings | Service tests prevent progression before resolution +3000 ms; a late alarm starts processing time +10000 ms. Two browser clients share the next deadline. Terminal service/browser fixtures cover rounds 12, 13 and 15, without Next. |
| 6 — preserved boundaries | Legacy privacy/deadline tests remain. Single lock emits no rival-ready update; snapshots return only own locked state. Update messages/logs contain identity/phase/revision, not pending commitments. Existing origin/auth, AFK, grace, no-contest, corruption/void, retention, settlement and backup checks remain. |
| 7 — actual learning and completion | Normal opening/every legal alternative, editable target and accepted Lock/Next, independent manual Pass without tactical hints, and completion only after acknowledgement. Unit checks cover intercepted/collided Expand, timeout exclusion, unrelated matches, terminal exit, skip, replay and unavailable/malformed storage. Browsers cover refresh, reordered snapshots, deliberately lost accepted Lock/Next responses, returning completion, replay preserving it and terminal exit acknowledgement. |
| 8 — entry and static rules | Home, welcome and How to play use ordinary match creation. Exactly two learning choices; pure static diagrams still call shared rules. Welcome creates no match, traps focus, Escape restores trigger and subsequent generic clicks bypass it. Resume/room/invite/Ranked paths bypass welcome; active learning replacement uses resignation. |
| 9 — browser / input / visuals | Fresh/returning sessions, untimed/timed Practice, Quick bot, full bot match/rematch, two human clients and locked/review refresh. Inspected 1440/720/390/320 CSS px screenshots, keyboard dialog/board, touch-emulated target selection, reduced motion, scrolling and rules reflow. 720×450 represents 200% CSS reflow from 1440×900. |
| 10 — required checks | Above commands, both audits and the CI-equivalent container backup/restore gate; no production database used. |

Migration 7 is additive and automatic on Node/Worker initialization. Old rows receive policy 1 defaults: 5000 ms, automatic progression, 1000 ms reveal. No state, deadline or pending move is rewritten. Every new production insert explicitly writes policy 2: 10000 ms, 3000 ms reveal and bot review or human automatic progression. Existing ready shells bind with their persisted policy. Fresh restart/rematch records opt into policy 2. Acknowledgements are pruned with expired finished guest matches; review remains active under existing retention rules.

Terminal rating writes remain idempotent with the existing maintenance recovery if a process stops between result and settlement; accepted terminal locks now settle immediately through the shared API.

## Screenshots

Local built-client evidence, not production screenshots or a human playtest:

- [Entry welcome](docs/learning-pacing-evidence/entry-welcome.png)
- [Desktop selection and Lock](docs/learning-pacing-evidence/learning-selected-1440.png)
- [Narrow learning controls](docs/learning-pacing-evidence/learning-selected-320.png)
- [Actual narrow review, actions and deltas](docs/learning-pacing-evidence/learning-review-390.png)
- [Completed bot result](docs/learning-pacing-evidence/bot-final-result.png)

## Production deployment — after separate authorization

1. Review/select the intended commit; record `git rev-parse HEAD`. Verify tracked source is unchanged with `git diff --exit-code` and `git diff --cached --exit-code`; preserve unrelated untracked work.
2. On Node 24, run npm ci, both audits, npm test, npm run build and npm run test:browser. Run npm run test:worker-runtime on Linux and the container gate from .github/workflows/verify.yml. Record results for that commit.
3. Ensure Wrangler is signed into the existing production account and production secrets are configured. Retain a recovery bookmark using the existing production recovery procedure before rollout. Do not change namespaces, secrets or auth allowlists for this change; never copy a local fixture database into production.
4. Run the exact configured command, without a staging flag:

```powershell
npm run deploy:worker
```

package.json expands this to npm run build followed by wrangler deploy. wrangler.jsonc defaults to override-game, server/worker.ts, assets directory ./dist and GAME / GameDurableObject, with the existing v1 SQLite class migration. Its build hook also runs npm run build. Application migration 7 runs inside the existing object; no new namespace/class migration is needed. Save Wrangler's deployment/version ID together with the reviewed Git SHA.

5. Compare production bytes with that build and check health using this read-only check:

```powershell
@'
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const origin = 'https://override-game.cnebolisa.workers.dev';
const local = readFileSync('dist/index.html', 'utf8');
const response = await fetch(origin + '/', { cache: 'no-store' });
assert.equal(response.status, 200);
const remote = await response.text();
const assets = html => [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(x => x[1]).sort();
assert.deepEqual(assets(remote), assets(local));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const file of readdirSync('dist/assets')) {
  const deployed = await fetch(origin + '/assets/' + file, { cache: 'no-store' });
  assert.equal(deployed.status, 200);
  assert.equal(hash(Buffer.from(await deployed.arrayBuffer())), hash(readFileSync('dist/assets/' + file)), file);
}
const health = await fetch(origin + '/api/health', { cache: 'no-store' });
assert.equal(health.status, 200);
assert.equal((await health.json()).ok, true);
console.log('Production assets match the reviewed build; health passed.');
'@ | node --input-type=module
```

6. Verify the real production URL in a fresh profile: no welcome on load, first generic click welcome, Escape focus return or recommended Learn; normal Easy untimed opening, editable selection, immediate Lock result, no next timer, idle/reload stays in review, Next opens exactly one decision, independent manual move and acknowledgement earn completion, replay remains available. Check How to play's two choices/static rules. Through normal selection, check timed Practice/Quick bot's ten-second deadline, stationary review and fresh ten seconds after Next. Refresh/help must not reset a deadline. Explicitly resign/exit temporary games. Record screenshots and policy/phase with the same Wrangler version/Git SHA. No public Ranked activity or production race/AFK/migration fixtures are needed.

## Evidence limits / optional novice check

No human comprehension/usability test, screen-reader evaluation, real-device interruption test or real Google-account Ranked journey was performed. Narrow/touch evidence uses Chromium emulation; zoom evidence is equivalent CSS reflow rather than browser-chrome zoom on a physical device. Deadline orderings use deterministic service linearizations plus concurrent Worker requests, not a production load test. Storage-refused progress survives within the tab only. The authorized production rollout and its actual checks are recorded above.

Optional novice test: give a fresh link without explanation, let the player enter and play three rounds, ask them to explain the score and hidden simultaneous choices, then make a self-chosen move. Record hesitations without supplying tactical instructions. Ten seconds and contextual teaching are product choices to evaluate, not proven usability gains. No tracking pipeline was added.
