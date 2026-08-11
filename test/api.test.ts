import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { seedDemo, type SeedIds } from '../src/seed.js';
import { buildServer } from '../src/api/server.js';

let db: DatabaseSync;
let ids: SeedIds;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb();
  ids = seedDemo(db);
  app = buildServer(db);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('API', () => {
  it('serves health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('serves the district funding summary', async () => {
    const res = await app.inject({ method: 'GET', url: `/entities/${ids.bluebonnetIsd}/funding-summary` });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].awarded_cents).toBe(63_000_000);
  });

  it('serves plan performance', async () => {
    const res = await app.inject({ method: 'GET', url: `/plans/${ids.bluebonnetPlan}/performance` });
    expect(res.statusCode).toBe(200);
    expect(res.json().goals).toHaveLength(2);
  });

  it('serves the funding impact report', async () => {
    const res = await app.inject({ method: 'GET', url: '/reports/funding-impact' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
  });

  it('maps invalid transitions to 409', async () => {
    const { id } = db
      .prepare('SELECT application_id AS id FROM awards WHERE id = ?')
      .get(ids.esserAward) as { id: number };
    const res = await app.inject({
      method: 'POST',
      url: `/applications/${id}/transition`,
      payload: { to: 'submitted' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('invalid_transition');
  });

  it('maps budget overruns to 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/awards/${ids.esserAward}/budget-lines`,
      payload: { category: 'capital_outlay', amountCents: 4_000_000 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('budget_exceeded');
  });

  it('maps missing resources to 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/plans/9999/performance' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });
});
