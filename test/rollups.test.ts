import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { seedDemo, type SeedIds } from '../src/seed.js';
import {
  entityFundingSummary,
  fundingImpact,
  grantUtilization,
  planPerformance,
} from '../src/reports/rollups.js';

let db: DatabaseSync;
let ids: SeedIds;

beforeEach(() => {
  db = openDb();
  ids = seedDemo(db);
});

describe('entityFundingSummary', () => {
  it('rolls campus awards up into the district, grouped by funding origin', () => {
    const rows = entityFundingSummary(db, ids.bluebonnetIsd);
    expect(rows).toHaveLength(1);
    const federal = rows[0]!;
    expect(federal.origin).toBe('federal');
    expect(federal.award_count).toBe(2);
    expect(federal.awarded_cents).toBe(63_000_000);
    expect(federal.budgeted_cents).toBe(57_000_000);
    expect(federal.spent_cents).toBe(20_500_000);
    expect(federal.remaining_cents).toBe(42_500_000);
  });

  it('excludes pipeline applications that have no award yet', () => {
    const rows = entityFundingSummary(db, ids.rioVerdeIsd);
    expect(rows).toHaveLength(1);
    const state = rows[0]!;
    expect(state.origin).toBe('state');
    expect(state.award_count).toBe(1);
    expect(state.awarded_cents).toBe(30_000_000);
    expect(state.spent_cents).toBe(5_000_000);
  });
});

describe('grantUtilization', () => {
  it('reports appropriation, pipeline, and spend for a grant', () => {
    const u = grantUtilization(db, ids.title1Grant);
    expect(u.grant_code).toBe('G-T1A-26');
    expect(u.application_count).toBe(2);
    expect(u.requested_cents).toBe(35_000_000);
    expect(u.awarded_cents).toBe(18_000_000);
    expect(u.budgeted_cents).toBe(15_000_000);
    expect(u.spent_cents).toBe(3_800_000);
    expect(u.unawarded_appropriation_cents).toBe(132_000_000);
  });
});

describe('planPerformance', () => {
  it('links goals to their funding and their latest metric readings', () => {
    const perf = planPerformance(db, ids.bluebonnetPlan);
    expect(perf.entity_name).toBe('Bluebonnet ISD');
    expect(perf.goals).toHaveLength(2);

    const reading = perf.goals[0]!;
    expect(reading.funded_cents).toBe(25_000_000);
    expect(reading.strategies).toHaveLength(2);
    const readingTarget = reading.targets[0]!;
    expect(readingTarget.metric_code).toBe('reading_meets_pct');
    expect(readingTarget.latest_value).toBe(51.0);
    expect(readingTarget.latest_period).toBe('2026-05-29');
    expect(readingTarget.progress).toBeCloseTo(9 / 13, 5);

    const attendance = perf.goals[1]!;
    expect(attendance.funded_cents).toBe(4_000_000);
    const attendanceTarget = attendance.targets[0]!;
    expect(attendanceTarget.latest_value).toBe(94.1);
    expect(attendanceTarget.progress).toBeCloseTo(2.6 / 3.5, 5);
  });
});

describe('fundingImpact', () => {
  it('repeats a goal\'s funded dollars once per target — the grain is (funding source, target)', () => {
    const secondMetric = db
      .prepare("INSERT INTO metrics (code, name, unit, direction) VALUES ('reading_masters_pct', 'Masters', 'percent', 'increase')")
      .run();
    const readingGoalId = (
      db.prepare('SELECT id FROM goals WHERE plan_id = ? AND ordinal = 1').get(ids.bluebonnetPlan) as { id: number }
    ).id;
    db.prepare(
      'INSERT INTO targets (goal_id, metric_id, baseline_value, target_value, due_fiscal_year) VALUES (?, ?, 20, 30, 2026)',
    ).run(readingGoalId, Number(secondMetric.lastInsertRowid));

    const esserRows = fundingImpact(db).filter((r) => r.funding_source === 'ESSER-III');
    expect(esserRows).toHaveLength(2);
    for (const row of esserRows) expect(row.funded_cents).toBe(25_000_000);
  });

  it('traces every funding source through plans to metric movement', () => {
    const rows = fundingImpact(db);
    expect(rows).toHaveLength(2);

    const esser = rows.find((r) => r.funding_source === 'ESSER-III')!;
    expect(esser.metric_code).toBe('reading_meets_pct');
    expect(esser.entity_name).toBe('Bluebonnet ISD');
    expect(esser.funded_cents).toBe(25_000_000);
    expect(esser.latest_value).toBe(51.0);
    expect(esser.progress).toBeCloseTo(9 / 13, 5);

    const title1 = rows.find((r) => r.funding_source === 'TITLE1A')!;
    expect(title1.metric_code).toBe('attendance_rate');
    expect(title1.funded_cents).toBe(4_000_000);
    expect(title1.progress).toBeCloseTo(2.6 / 3.5, 5);
  });
});
