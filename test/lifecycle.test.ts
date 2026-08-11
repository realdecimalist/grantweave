import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { createFundingSource, createGrant } from '../src/domain/catalog.js';
import { createEntity } from '../src/domain/entities.js';
import {
  addBudgetLine,
  createApplication,
  createAward,
  recordExpenditure,
  transitionApplication,
} from '../src/domain/lifecycle.js';
import { DomainError } from '../src/domain/errors.js';

interface Fixture {
  db: DatabaseSync;
  grantId: number;
  districtId: number;
}

function fixture(): Fixture {
  const db = openDb();
  const fsId = createFundingSource(db, { code: 'FS1', name: 'Test Source', origin: 'federal' });
  const grantId = createGrant(db, {
    fundingSourceId: fsId,
    code: 'G1',
    title: 'Test Grant',
    fiscalYear: 2026,
    appropriationCents: 100_000_000,
  });
  const districtId = createEntity(db, { kind: 'district', name: 'Test ISD', localCode: '900-900' });
  return { db, grantId, districtId };
}

function approvedApplication(f: Fixture, requestedCents = 10_000_000): number {
  const appId = createApplication(f.db, { grantId: f.grantId, entityId: f.districtId, requestedCents });
  transitionApplication(f.db, appId, 'submitted');
  transitionApplication(f.db, appId, 'under_review');
  transitionApplication(f.db, appId, 'approved');
  return appId;
}

describe('application lifecycle', () => {
  it('walks draft -> submitted -> under_review -> approved -> award -> budget -> expenditure', () => {
    const f = fixture();
    const appId = approvedApplication(f);
    const awardId = createAward(f.db, {
      applicationId: appId,
      awardedCents: 9_000_000,
      periodStart: '2025-09-01',
      periodEnd: '2026-08-31',
    });
    const lineId = addBudgetLine(f.db, { awardId, category: 'payroll', amountCents: 5_000_000 });
    const expId = recordExpenditure(f.db, {
      budgetLineId: lineId,
      amountCents: 1_000_000,
      spentOn: '2025-10-01',
      description: 'first draw',
    });
    expect(expId).toBeGreaterThan(0);
  });

  it('rejects skipping straight from draft to approved', () => {
    const f = fixture();
    const appId = createApplication(f.db, { grantId: f.grantId, entityId: f.districtId, requestedCents: 1_000 });
    expect(() => transitionApplication(f.db, appId, 'approved')).toThrowError(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });

  it('rejects awarding an application that is not approved', () => {
    const f = fixture();
    const appId = createApplication(f.db, { grantId: f.grantId, entityId: f.districtId, requestedCents: 1_000 });
    transitionApplication(f.db, appId, 'submitted');
    expect(() =>
      createAward(f.db, { applicationId: appId, awardedCents: 1_000, periodStart: '2025-09-01', periodEnd: '2026-08-31' }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_transition' }));
  });

  it('rejects a second application from the same entity to the same grant', () => {
    const f = fixture();
    createApplication(f.db, { grantId: f.grantId, entityId: f.districtId, requestedCents: 1_000 });
    expect(() =>
      createApplication(f.db, { grantId: f.grantId, entityId: f.districtId, requestedCents: 2_000 }),
    ).toThrowError(expect.objectContaining({ code: 'duplicate' }));
  });

  it('rejects applications to a grant that is not open', () => {
    const f = fixture();
    f.db.prepare("UPDATE grants SET status = 'closed' WHERE id = ?").run(f.grantId);
    expect(() =>
      createApplication(f.db, { grantId: f.grantId, entityId: f.districtId, requestedCents: 1_000 }),
    ).toThrowError(expect.objectContaining({ code: 'validation' }));
  });

  it('caps budget lines at the awarded amount', () => {
    const f = fixture();
    const awardId = createAward(f.db, {
      applicationId: approvedApplication(f),
      awardedCents: 9_000_000,
      periodStart: '2025-09-01',
      periodEnd: '2026-08-31',
    });
    addBudgetLine(f.db, { awardId, category: 'payroll', amountCents: 8_000_000 });
    expect(() => addBudgetLine(f.db, { awardId, category: 'supplies', amountCents: 2_000_000 })).toThrowError(
      expect.objectContaining({ code: 'budget_exceeded' }),
    );
  });

  it('rejects a duplicate budget category on one award', () => {
    const f = fixture();
    const awardId = createAward(f.db, {
      applicationId: approvedApplication(f),
      awardedCents: 9_000_000,
      periodStart: '2025-09-01',
      periodEnd: '2026-08-31',
    });
    addBudgetLine(f.db, { awardId, category: 'payroll', amountCents: 1_000_000 });
    expect(() => addBudgetLine(f.db, { awardId, category: 'payroll', amountCents: 1_000_000 })).toThrowError(
      expect.objectContaining({ code: 'duplicate' }),
    );
  });

  it('caps expenditures at the budget line amount', () => {
    const f = fixture();
    const awardId = createAward(f.db, {
      applicationId: approvedApplication(f),
      awardedCents: 9_000_000,
      periodStart: '2025-09-01',
      periodEnd: '2026-08-31',
    });
    const lineId = addBudgetLine(f.db, { awardId, category: 'payroll', amountCents: 2_000_000 });
    recordExpenditure(f.db, { budgetLineId: lineId, amountCents: 1_500_000, spentOn: '2025-10-01', description: 'a' });
    expect(() =>
      recordExpenditure(f.db, { budgetLineId: lineId, amountCents: 600_000, spentOn: '2025-11-01', description: 'b' }),
    ).toThrowError(expect.objectContaining({ code: 'budget_exceeded' }));
  });

  it('freezes spending on a suspended award', () => {
    const f = fixture();
    const awardId = createAward(f.db, {
      applicationId: approvedApplication(f),
      awardedCents: 9_000_000,
      periodStart: '2025-09-01',
      periodEnd: '2026-08-31',
    });
    const lineId = addBudgetLine(f.db, { awardId, category: 'payroll', amountCents: 2_000_000 });
    f.db.prepare("UPDATE awards SET status = 'suspended' WHERE id = ?").run(awardId);
    expect(() =>
      recordExpenditure(f.db, { budgetLineId: lineId, amountCents: 1_000, spentOn: '2025-10-01', description: 'x' }),
    ).toThrowError(expect.objectContaining({ code: 'validation' }));
  });

  it('surfaces DomainError with an HTTP status', () => {
    const f = fixture();
    try {
      transitionApplication(f.db, 999, 'submitted');
      expect.unreachable('expected a DomainError');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).status).toBe(404);
    }
  });
});
