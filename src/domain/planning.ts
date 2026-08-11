import type { DatabaseSync } from 'node:sqlite';
import { lastId, transact } from '../db.js';
import { assertCents, DomainError, rethrowConstraint } from './errors.js';
import { isWithinSubtree } from './entities.js';

export function createPlan(
  db: DatabaseSync,
  input: { entityId: number; fiscalYear: number; title: string },
): number {
  const entity = db.prepare('SELECT id FROM entities WHERE id = ?').get(input.entityId);
  if (!entity) throw new DomainError('not_found', `entity ${input.entityId} not found`);
  try {
    const res = db
      .prepare('INSERT INTO plans (entity_id, fiscal_year, title) VALUES (?, ?, ?)')
      .run(input.entityId, input.fiscalYear, input.title);
    return lastId(res);
  } catch (err) {
    rethrowConstraint(
      err,
      'duplicate',
      `entity ${input.entityId} already has a plan for fiscal year ${input.fiscalYear}`,
    );
  }
}

export function adoptPlan(db: DatabaseSync, planId: number): void {
  const plan = db.prepare('SELECT status FROM plans WHERE id = ?').get(planId) as
    | { status: string }
    | undefined;
  if (!plan) throw new DomainError('not_found', `plan ${planId} not found`);
  if (plan.status !== 'draft') {
    throw new DomainError('invalid_transition', `plan ${planId} is ${plan.status}; only drafts can be adopted`);
  }
  db.prepare("UPDATE plans SET status = 'adopted' WHERE id = ?").run(planId);
}

export function addGoal(
  db: DatabaseSync,
  input: { planId: number; ordinal: number; statement: string },
): number {
  const plan = db.prepare('SELECT id FROM plans WHERE id = ?').get(input.planId);
  if (!plan) throw new DomainError('not_found', `plan ${input.planId} not found`);
  try {
    const res = db
      .prepare('INSERT INTO goals (plan_id, ordinal, statement) VALUES (?, ?, ?)')
      .run(input.planId, input.ordinal, input.statement);
    return lastId(res);
  } catch (err) {
    rethrowConstraint(err, 'duplicate', `plan ${input.planId} already has goal #${input.ordinal}`);
  }
}

export function addStrategy(
  db: DatabaseSync,
  input: { goalId: number; ordinal: number; description: string },
): number {
  const goal = db.prepare('SELECT id FROM goals WHERE id = ?').get(input.goalId);
  if (!goal) throw new DomainError('not_found', `goal ${input.goalId} not found`);
  try {
    const res = db
      .prepare('INSERT INTO strategies (goal_id, ordinal, description) VALUES (?, ?, ?)')
      .run(input.goalId, input.ordinal, input.description);
    return lastId(res);
  } catch (err) {
    rethrowConstraint(err, 'duplicate', `goal ${input.goalId} already has strategy #${input.ordinal}`);
  }
}

export function fundStrategy(
  db: DatabaseSync,
  input: { strategyId: number; awardId: number; plannedCents: number },
): number {
  assertCents('plannedCents', input.plannedCents);
  return transact(db, () => {
    const strategy = db
      .prepare(
        `SELECT p.entity_id AS plan_entity_id
         FROM strategies s
         JOIN goals g ON g.id = s.goal_id
         JOIN plans p ON p.id = g.plan_id
         WHERE s.id = ?`,
      )
      .get(input.strategyId) as { plan_entity_id: number } | undefined;
    if (!strategy) throw new DomainError('not_found', `strategy ${input.strategyId} not found`);

    const award = db
      .prepare(
        `SELECT aw.awarded_cents, aw.status, ap.entity_id AS award_entity_id
         FROM awards aw JOIN applications ap ON ap.id = aw.application_id
         WHERE aw.id = ?`,
      )
      .get(input.awardId) as
      | { awarded_cents: number; status: string; award_entity_id: number }
      | undefined;
    if (!award) throw new DomainError('not_found', `award ${input.awardId} not found`);
    if (award.status !== 'active') {
      throw new DomainError('validation', `award ${input.awardId} is ${award.status}; funding is frozen`);
    }
    if (!isWithinSubtree(db, strategy.plan_entity_id, award.award_entity_id)) {
      throw new DomainError(
        'funding_misaligned',
        `award ${input.awardId} belongs to entity ${award.award_entity_id}, which is outside the plan entity ${strategy.plan_entity_id} and its campuses`,
      );
    }
    const { planned } = db
      .prepare('SELECT COALESCE(SUM(planned_cents), 0) AS planned FROM strategy_funding WHERE award_id = ?')
      .get(input.awardId) as { planned: number };
    if (planned + input.plannedCents > award.awarded_cents) {
      throw new DomainError(
        'budget_exceeded',
        `strategy funding would total ${planned + input.plannedCents} cents, exceeding the ${award.awarded_cents}-cent award`,
      );
    }
    try {
      const res = db
        .prepare('INSERT INTO strategy_funding (strategy_id, award_id, planned_cents) VALUES (?, ?, ?)')
        .run(input.strategyId, input.awardId, input.plannedCents);
      return lastId(res);
    } catch (err) {
      rethrowConstraint(
        err,
        'duplicate',
        `strategy ${input.strategyId} is already funded by award ${input.awardId}`,
      );
    }
  });
}
