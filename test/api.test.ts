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

  it('rejects an empty body with 400, not 500', async () => {
    const res = await app.inject({ method: 'POST', url: '/funding-sources', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
  });

  it('rejects malformed JSON with 400, not 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/funding-sources',
      payload: '{not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown enum value with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/funding-sources',
      payload: { code: 'X', name: 'X', origin: 'municipal' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-numeric cents with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/grants',
      payload: { fundingSourceId: 1, code: 'GX', title: 'X', fiscalYear: 2026, appropriationCents: 'abc' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects fractional cents with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/awards/${ids.esserAward}/budget-lines`,
      payload: { category: 'other_operating', amountCents: 100.5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-numeric path ids with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/grants/abc/utilization' });
    expect(res.statusCode).toBe(400);
  });

  it('lists entities and grants for browsing the seeded world', async () => {
    const entities = await app.inject({ method: 'GET', url: '/entities' });
    expect(entities.statusCode).toBe(200);
    expect(entities.json()).toHaveLength(5);
    const grants = await app.inject({ method: 'GET', url: '/grants' });
    expect(grants.statusCode).toBe(200);
    expect(grants.json()).toHaveLength(3);
  });
});
