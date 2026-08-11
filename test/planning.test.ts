import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { createFundingSource, createGrant, createMetric } from '../src/domain/catalog.js';
import { createEntity } from '../src/domain/entities.js';
import {
  createApplication,
  createAward,
  transitionApplication,
} from '../src/domain/lifecycle.js';
import { addGoal, addStrategy, adoptPlan, createPlan, fundStrategy } from '../src/domain/planning.js';
import { addTarget, recordReading } from '../src/domain/performance.js';

function fixture() {
  const db = openDb();
  const fsId = createFundingSource(db, { code: 'FS1', name: 'Test Source', origin: 'state' });
  const grantId = createGrant(db, {
    fundingSourceId: fsId,
    code: 'G1',
    title: 'Test Grant',
    fiscalYear: 2026,
    appropriationCents: 100_000_000,
  });
  const districtId = createEntity(db, { kind: 'district', name: 'Alpha ISD', localCode: '900-900' });
  const campusId = createEntity(db, {
    kind: 'campus',
    name: 'Alpha Elementary',
    localCode: '900-900-001',
    parentId: districtId,
  });
  const otherDistrictId = createEntity(db, { kind: 'district', name: 'Beta ISD', localCode: '901-901' });

  const award = (entityId: number, cents: number) => {
    const appId = createApplication(db, { grantId, entityId, requestedCents: cents });
    transitionApplication(db, appId, 'submitted');
    transitionApplication(db, appId, 'under_review');
    transitionApplication(db, appId, 'approved');
    return createAward(db, {
      applicationId: appId,
      awardedCents: cents,
      periodStart: '2025-09-01',
      periodEnd: '2026-08-31',
    });
  };

  const planId = createPlan(db, { entityId: districtId, fiscalYear: 2026, title: 'Alpha DIP' });
  const goalId = addGoal(db, { planId, ordinal: 1, statement: 'Improve outcomes' });
  const strategyId = addStrategy(db, { goalId, ordinal: 1, description: 'Do the work' });

  return { db, grantId, districtId, campusId, otherDistrictId, planId, goalId, strategyId, award };
}

describe('entity hierarchy', () => {
  it('rejects a campus without a parent', () => {
    const db = openDb();
    expect(() => createEntity(db, { kind: 'campus', name: 'Orphan', localCode: 'x' })).toThrowError(
      expect.objectContaining({ code: 'validation' }),
    );
  });

  it('rejects a campus parented by a service center', () => {
    const db = openDb();
    const escId = createEntity(db, { kind: 'service_center', name: 'Region 99', localCode: 'esc-99' });
    expect(() =>
      createEntity(db, { kind: 'campus', name: 'Wrong', localCode: 'x', parentId: escId }),
    ).toThrowError(expect.objectContaining({ code: 'validation' }));
  });
});

describe('strategy funding', () => {
  it('accepts funding from the plan entity itself and from its campuses', () => {
    const f = fixture();
    const districtAward = f.award(f.districtId, 5_000_000);
    const campusAward = f.award(f.campusId, 3_000_000);
    expect(fundStrategy(f.db, { strategyId: f.strategyId, awardId: districtAward, plannedCents: 1_000_000 })).toBeGreaterThan(0);
    expect(fundStrategy(f.db, { strategyId: f.strategyId, awardId: campusAward, plannedCents: 1_000_000 })).toBeGreaterThan(0);
  });

  it("rejects funding a plan with another district's award", () => {
    const f = fixture();
    const foreignAward = f.award(f.otherDistrictId, 5_000_000);
    expect(() =>
      fundStrategy(f.db, { strategyId: f.strategyId, awardId: foreignAward, plannedCents: 1_000_000 }),
    ).toThrowError(expect.objectContaining({ code: 'funding_misaligned' }));
  });

  it('caps total planned funding at the awarded amount', () => {
    const f = fixture();
    const awardId = f.award(f.districtId, 5_000_000);
    fundStrategy(f.db, { strategyId: f.strategyId, awardId, plannedCents: 4_000_000 });
    const secondStrategy = addStrategy(f.db, { goalId: f.goalId, ordinal: 2, description: 'More work' });
    expect(() =>
      fundStrategy(f.db, { strategyId: secondStrategy, awardId, plannedCents: 2_000_000 }),
    ).toThrowError(expect.objectContaining({ code: 'budget_exceeded' }));
  });
});

describe('plans, targets, readings', () => {
  it('adopts a draft plan exactly once', () => {
    const f = fixture();
    adoptPlan(f.db, f.planId);
    expect(() => adoptPlan(f.db, f.planId)).toThrowError(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });

  it('rejects a target that moves against the metric direction', () => {
    const f = fixture();
    const metricId = createMetric(f.db, {
      code: 'dropout_rate',
      name: 'Dropout rate',
      unit: 'percent',
      direction: 'decrease',
    });
    expect(() =>
      addTarget(f.db, { goalId: f.goalId, metricId, baselineValue: 5, targetValue: 7, dueFiscalYear: 2026 }),
    ).toThrowError(expect.objectContaining({ code: 'validation' }));
  });

  it('rejects readings with a non-ISO period', () => {
    const f = fixture();
    const metricId = createMetric(f.db, {
      code: 'attendance',
      name: 'Attendance',
      unit: 'percent',
      direction: 'increase',
    });
    expect(() =>
      recordReading(f.db, { metricId, entityId: f.districtId, period: '2026-Q1', value: 90, source: 'test' }),
    ).toThrowError(expect.objectContaining({ code: 'validation' }));
  });
});
