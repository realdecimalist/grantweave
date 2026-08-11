import type { DatabaseSync } from 'node:sqlite';
import { lastId } from '../db.js';
import { DomainError, rethrowUnique } from './errors.js';

export function addTarget(
  db: DatabaseSync,
  input: {
    goalId: number;
    metricId: number;
    baselineValue: number;
    targetValue: number;
    dueFiscalYear: number;
  },
): number {
  const goal = db.prepare('SELECT id FROM goals WHERE id = ?').get(input.goalId);
  if (!goal) throw new DomainError('not_found', `goal ${input.goalId} not found`);
  const metric = db.prepare('SELECT direction FROM metrics WHERE id = ?').get(input.metricId) as
    | { direction: 'increase' | 'decrease' }
    | undefined;
  if (!metric) throw new DomainError('not_found', `metric ${input.metricId} not found`);
  const delta = input.targetValue - input.baselineValue;
  if (metric.direction === 'increase' ? delta <= 0 : delta >= 0) {
    throw new DomainError(
      'validation',
      `target ${input.targetValue} does not ${metric.direction} from baseline ${input.baselineValue}`,
    );
  }
  try {
    const res = db
      .prepare(
        'INSERT INTO targets (goal_id, metric_id, baseline_value, target_value, due_fiscal_year) VALUES (?, ?, ?, ?, ?)',
      )
      .run(input.goalId, input.metricId, input.baselineValue, input.targetValue, input.dueFiscalYear);
    return lastId(res);
  } catch (err) {
    rethrowUnique(err, 'duplicate', `goal ${input.goalId} already targets metric ${input.metricId}`);
  }
}

export function recordReading(
  db: DatabaseSync,
  input: { metricId: number; entityId: number; period: string; value: number; source: string },
): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.period)) {
    throw new DomainError('validation', `period must be an ISO date (YYYY-MM-DD), got "${input.period}"`);
  }
  const metric = db.prepare('SELECT id FROM metrics WHERE id = ?').get(input.metricId);
  if (!metric) throw new DomainError('not_found', `metric ${input.metricId} not found`);
  const entity = db.prepare('SELECT id FROM entities WHERE id = ?').get(input.entityId);
  if (!entity) throw new DomainError('not_found', `entity ${input.entityId} not found`);
  try {
    const res = db
      .prepare('INSERT INTO readings (metric_id, entity_id, period, value, source) VALUES (?, ?, ?, ?, ?)')
      .run(input.metricId, input.entityId, input.period, input.value, input.source);
    return lastId(res);
  } catch (err) {
    rethrowUnique(
      err,
      'duplicate',
      `metric ${input.metricId} already has a reading for entity ${input.entityId} in period ${input.period}`,
    );
  }
}

export function progressToTarget(baseline: number, target: number, latest: number): number {
  const span = target - baseline;
  const gained = latest - baseline;
  const ratio = gained / span;
  return Math.min(1, Math.max(0, ratio));
}
