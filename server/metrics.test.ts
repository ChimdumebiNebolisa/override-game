import assert from 'node:assert/strict';
import { test } from 'vitest';
import { openDatabase } from './db';
import { createBotMatch } from './matches';
import { metricsReport, recordClientTelemetry } from './metrics';
import type { Session } from './http';
import { createInitialState, type RoundResult } from '../src/shared/rules';

test('report separates bot rematches and voluntary versus timeout passes from revealed rounds', () => {
  const db = openDatabase(':memory:');
  try {
    const session: Session = { id: 'guest', uid: null, createdAt: 0, expiresAt: 1_000_000 };
    const practice = createBotMatch(db, session, 'Player', 'practice', 'easy');
    const quick = createBotMatch(db, session, 'Player', 'quick', 'hard');
    const final = { ...createInitialState(), status: 'finished' as const, winner: 'A' as const, endingReason: 'standard' as const };
    for (const id of [practice, quick]) {
      db.prepare("UPDATE matches SET status = 'finished', state_json = ?, ended_at = started_at + 60_000, result_type = 'standard' WHERE id = ?")
        .run(JSON.stringify(final), id);
    }
    const round: RoundResult = {
      state: final, score: { A: 4, B: 4 },
      outcomes: {
        A: { action: { type: 'pass' }, success: true, reason: 'passed', energySpent: 0, energyEarned: 0 },
        B: { action: { type: 'expand', target: 17 }, success: true, reason: 'claimed', energySpent: 0, energyEarned: 0 },
      },
    };
    db.prepare('INSERT INTO round_results (match_id, round, result_json, resolved_at) VALUES (?, 1, ?, 1)')
      .run(practice, JSON.stringify(round));
    const timeoutRound: RoundResult = {
      ...round,
      outcomes: {
        ...round.outcomes,
        A: { action: { type: 'pass' }, success: true, reason: 'automatic-pass', energySpent: 0, energyEarned: 0 },
      },
    };
    db.prepare('INSERT INTO round_results (match_id, round, result_json, resolved_at) VALUES (?, 3, ?, 3)')
      .run(quick, JSON.stringify(timeoutRound));
    createBotMatch(db, session, 'Player', 'practice', 'easy', practice);
    createBotMatch(db, session, 'Player', 'quick', 'hard', quick);
    db.prepare("INSERT INTO pending_actions (match_id, round, player, action_json, locked_at) VALUES (?, 4, 'A', ?, 4)")
      .run(quick, JSON.stringify({ type: 'override', target: 24 }));
    recordClientTelemetry(db, session.id, 'homepage_opened', null, 100);

    const report = metricsReport(db, 200);
    assert.equal(report.funnel.homepageOpened, 1);
    assert.equal(report.funnel.round3Reached, 1);
    assert.equal(report.gameplay.voluntaryPassRate, 0.5);
    assert.equal(report.gameplay.automaticTimeoutPassRate, 0.5);
    assert.equal(report.gameplay.actionDistribution.human.override, 0);
    assert.equal(report.rematchRates.practiceBot.rate, 1);
    assert.equal(report.rematchRates.quickBot.rate, 1);
    assert.equal(report.rematchRates.quickHuman.rate, null);
    assert.equal(report.sideBalance.easyBot.aWins, 1);
    assert.equal(report.sideBalance.hardBot.aWins, 1);
    assert.ok(!JSON.stringify(report).includes('"target":24'));
  } finally {
    db.close();
  }
});

test('report separates both Ranked players ready from a binding match start', () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare(`INSERT INTO matches (id, mode, player_a_key, player_b_key, player_a_name, player_b_name,
      state_json, status, ready_a, ready_b)
      VALUES ('ready-shell', 'ranked', 'a', 'b', 'Alpha', 'Bravo', ?, 'readying', 1, 1)`)
      .run(JSON.stringify(createInitialState()));

    const report = metricsReport(db, 200);
    assert.equal(report.funnel.matchShellCreated, 1);
    assert.equal(report.funnel.bothPlayersReady, 1);
    assert.equal(report.funnel.bindingMatchStarted, 0);
  } finally {
    db.close();
  }
});

test('client telemetry rejects arbitrary names and values', () => {
  const db = openDatabase(':memory:');
  try {
    assert.throws(() => recordClientTelemetry(db, 'guest', 'pending_action', 'ranked'), { status: 400 });
    assert.throws(() => recordClientTelemetry(db, 'guest', 'mode_selected', 'secret'), { status: 400 });
  } finally {
    db.close();
  }
});
