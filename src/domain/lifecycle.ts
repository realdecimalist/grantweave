import type { DatabaseSync } from 'node:sqlite';
import { lastId, transact } from '../db.js';
import { assertCents, DomainError, rethrowConstraint } from './errors.js';

export type ApplicationStatus =
  | 'draft'
  | 'submitted'
  | 'under_review'
  | 'approved'
  | 'rejected'
  | 'withdrawn';

export type BudgetCategory =
  | 'payroll'
  | 'professional_services'
  | 'supplies'
  | 'other_operating'
  | 'capital_outlay';

const TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  draft: ['submitted', 'withdrawn'],
  submitted: ['under_review', 'withdrawn'],
  under_review: ['approved', 'rejected', 'withdrawn'],
  approved: [],
  rejected: [],
  withdrawn: [],
};

export function createApplication(
  db: DatabaseSync,
  input: { grantId: number; entityId: number; requestedCents: number },
): number {
  assertCents('requestedCents', input.requestedCents);
  const grant = db.prepare('SELECT status FROM grants WHERE id = ?').get(input.grantId) as
    | { status: string }
    | undefined;
  if (!grant) throw new DomainError('not_found', `grant ${input.grantId} not found`);
  if (grant.status !== 'open') {
    throw new DomainError('validation', `grant ${input.grantId} is ${grant.status}, not open for applications`);
  }
  const entity = db.prepare('SELECT id FROM entities WHERE id = ?').get(input.entityId);
  if (!entity) throw new DomainError('not_found', `entity ${input.entityId} not found`);
  try {
    const res = db
      .prepare('INSERT INTO applications (grant_id, entity_id, requested_cents) VALUES (?, ?, ?)')
      .run(input.grantId, input.entityId, input.requestedCents);
    return lastId(res);
  } catch (err) {
    rethrowConstraint(
      err,
      'duplicate',
      `entity ${input.entityId} already has an application for grant ${input.grantId}`,
    );
  }
}

export function transitionApplication(
  db: DatabaseSync,
  applicationId: number,
  to: ApplicationStatus,
): void {
  const app = db.prepare('SELECT status FROM applications WHERE id = ?').get(applicationId) as
    | { status: ApplicationStatus }
    | undefined;
  if (!app) throw new DomainError('not_found', `application ${applicationId} not found`);
  if (!TRANSITIONS[app.status].includes(to)) {
    throw new DomainError('invalid_transition', `cannot move application from ${app.status} to ${to}`);
  }
  const submittedAt = to === 'submitted' ? new Date().toISOString() : null;
  db.prepare(
    'UPDATE applications SET status = ?, submitted_at = COALESCE(?, submitted_at) WHERE id = ?',
  ).run(to, submittedAt, applicationId);
}

export function createAward(
  db: DatabaseSync,
  input: { applicationId: number; awardedCents: number; periodStart: string; periodEnd: string },
): number {
  assertCents('awardedCents', input.awardedCents);
  return transact(db, () => {
    const app = db
      .prepare(
        `SELECT ap.status, g.id AS grant_id, g.appropriation_cents,
                COALESCE((SELECT SUM(aw.awarded_cents)
                          FROM awards aw JOIN applications ap2 ON ap2.id = aw.application_id
                          WHERE ap2.grant_id = g.id), 0) AS already_awarded
         FROM applications ap JOIN grants g ON g.id = ap.grant_id
         WHERE ap.id = ?`,
      )
      .get(input.applicationId) as
      | { status: ApplicationStatus; grant_id: number; appropriation_cents: number; already_awarded: number }
      | undefined;
    if (!app) throw new DomainError('not_found', `application ${input.applicationId} not found`);
    if (app.status !== 'approved') {
      throw new DomainError(
        'invalid_transition',
        `application ${input.applicationId} is ${app.status}; only approved applications can be awarded`,
      );
    }
    if (app.already_awarded + input.awardedCents > app.appropriation_cents) {
      throw new DomainError(
        'budget_exceeded',
        `awards for grant ${app.grant_id} would total ${app.already_awarded + input.awardedCents} cents, exceeding its ${app.appropriation_cents}-cent appropriation`,
      );
    }
    try {
      const res = db
        .prepare(
          'INSERT INTO awards (application_id, awarded_cents, period_start, period_end) VALUES (?, ?, ?, ?)',
        )
        .run(input.applicationId, input.awardedCents, input.periodStart, input.periodEnd);
      return lastId(res);
    } catch (err) {
      rethrowConstraint(err, 'duplicate', `application ${input.applicationId} already has an award`);
    }
  });
}

export function addBudgetLine(
  db: DatabaseSync,
  input: { awardId: number; category: BudgetCategory; amountCents: number },
): number {
  assertCents('amountCents', input.amountCents);
  return transact(db, () => {
    const award = db.prepare('SELECT awarded_cents, status FROM awards WHERE id = ?').get(input.awardId) as
      | { awarded_cents: number; status: string }
      | undefined;
    if (!award) throw new DomainError('not_found', `award ${input.awardId} not found`);
    if (award.status !== 'active') {
      throw new DomainError('validation', `award ${input.awardId} is ${award.status}; budget is frozen`);
    }
    const { budgeted } = db
      .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS budgeted FROM budget_lines WHERE award_id = ?')
      .get(input.awardId) as { budgeted: number };
    if (budgeted + input.amountCents > award.awarded_cents) {
      throw new DomainError(
        'budget_exceeded',
        `budget lines would total ${budgeted + input.amountCents} cents, exceeding the ${award.awarded_cents}-cent award`,
      );
    }
    try {
      const res = db
        .prepare('INSERT INTO budget_lines (award_id, category, amount_cents) VALUES (?, ?, ?)')
        .run(input.awardId, input.category, input.amountCents);
      return lastId(res);
    } catch (err) {
      rethrowConstraint(err, 'duplicate', `award ${input.awardId} already budgets category ${input.category}`);
    }
  });
}

export function recordExpenditure(
  db: DatabaseSync,
  input: { budgetLineId: number; amountCents: number; spentOn: string; description: string },
): number {
  assertCents('amountCents', input.amountCents);
  return transact(db, () => {
    const line = db
      .prepare(
        `SELECT bl.amount_cents, a.status
         FROM budget_lines bl JOIN awards a ON a.id = bl.award_id
         WHERE bl.id = ?`,
      )
      .get(input.budgetLineId) as { amount_cents: number; status: string } | undefined;
    if (!line) throw new DomainError('not_found', `budget line ${input.budgetLineId} not found`);
    if (line.status !== 'active') {
      throw new DomainError('validation', `award for budget line ${input.budgetLineId} is ${line.status}; spending is frozen`);
    }
    const { spent } = db
      .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS spent FROM expenditures WHERE budget_line_id = ?')
      .get(input.budgetLineId) as { spent: number };
    if (spent + input.amountCents > line.amount_cents) {
      throw new DomainError(
        'budget_exceeded',
        `expenditures would total ${spent + input.amountCents} cents, exceeding the ${line.amount_cents}-cent budget line`,
      );
    }
    const res = db
      .prepare(
        'INSERT INTO expenditures (budget_line_id, amount_cents, spent_on, description) VALUES (?, ?, ?, ?)',
      )
      .run(input.budgetLineId, input.amountCents, input.spentOn, input.description);
    return lastId(res);
  });
}
