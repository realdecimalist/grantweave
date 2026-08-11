import type { DatabaseSync } from 'node:sqlite';
import { lastId } from '../db.js';
import { assertCents, DomainError, rethrowConstraint } from './errors.js';

export type Origin = 'federal' | 'state' | 'local' | 'private';
export type MetricUnit = 'percent' | 'count' | 'currency' | 'ratio';
export type MetricDirection = 'increase' | 'decrease';

export function createFundingSource(
  db: DatabaseSync,
  input: { code: string; name: string; origin: Origin },
): number {
  try {
    const res = db
      .prepare('INSERT INTO funding_sources (code, name, origin) VALUES (?, ?, ?)')
      .run(input.code, input.name, input.origin);
    return lastId(res);
  } catch (err) {
    rethrowConstraint(err, 'duplicate', `funding source code ${input.code} already exists`);
  }
}

export function createGrant(
  db: DatabaseSync,
  input: {
    fundingSourceId: number;
    code: string;
    title: string;
    fiscalYear: number;
    appropriationCents: number;
  },
): number {
  assertCents('appropriationCents', input.appropriationCents, 0);
  const source = db.prepare('SELECT id FROM funding_sources WHERE id = ?').get(input.fundingSourceId);
  if (!source) throw new DomainError('not_found', `funding source ${input.fundingSourceId} not found`);
  try {
    const res = db
      .prepare(
        'INSERT INTO grants (funding_source_id, code, title, fiscal_year, appropriation_cents) VALUES (?, ?, ?, ?, ?)',
      )
      .run(input.fundingSourceId, input.code, input.title, input.fiscalYear, input.appropriationCents);
    return lastId(res);
  } catch (err) {
    rethrowConstraint(err, 'duplicate', `grant code ${input.code} already exists`);
  }
}

export function createMetric(
  db: DatabaseSync,
  input: { code: string; name: string; unit: MetricUnit; direction: MetricDirection },
): number {
  try {
    const res = db
      .prepare('INSERT INTO metrics (code, name, unit, direction) VALUES (?, ?, ?, ?)')
      .run(input.code, input.name, input.unit, input.direction);
    return lastId(res);
  } catch (err) {
    rethrowConstraint(err, 'duplicate', `metric code ${input.code} already exists`);
  }
}
