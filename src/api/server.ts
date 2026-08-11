import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../db.js';
import { DomainError } from '../domain/errors.js';
import { createFundingSource, createGrant, createMetric } from '../domain/catalog.js';
import { createEntity } from '../domain/entities.js';
import {
  addBudgetLine,
  createApplication,
  createAward,
  recordExpenditure,
  transitionApplication,
  type ApplicationStatus,
} from '../domain/lifecycle.js';
import { addGoal, addStrategy, adoptPlan, createPlan, fundStrategy } from '../domain/planning.js';
import { addTarget, recordReading } from '../domain/performance.js';
import {
  entityFundingSummary,
  fundingImpact,
  grantUtilization,
  planPerformance,
} from '../reports/rollups.js';

export function buildServer(db: DatabaseSync): FastifyInstance {
  const app = Fastify();

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) {
      return reply.status(err.status).send({ error: err.code, message: err.message });
    }
    app.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'unexpected server error' });
  });

  app.get('/health', async () => ({ ok: true }));

  app.post('/funding-sources', async (req, reply) => {
    const body = req.body as { code: string; name: string; origin: never };
    const id = createFundingSource(db, body);
    return reply.status(201).send({ id });
  });

  app.post('/grants', async (req, reply) => {
    const body = req.body as {
      fundingSourceId: number;
      code: string;
      title: string;
      fiscalYear: number;
      appropriationCents: number;
    };
    const id = createGrant(db, body);
    return reply.status(201).send({ id });
  });

  app.get('/grants/:id/utilization', async (req) => {
    const { id } = req.params as { id: string };
    return grantUtilization(db, Number(id));
  });

  app.post('/entities', async (req, reply) => {
    const body = req.body as { kind: never; name: string; localCode: string; parentId?: number };
    const id = createEntity(db, body);
    return reply.status(201).send({ id });
  });

  app.get('/entities/:id/funding-summary', async (req) => {
    const { id } = req.params as { id: string };
    return entityFundingSummary(db, Number(id));
  });

  app.post('/applications', async (req, reply) => {
    const body = req.body as { grantId: number; entityId: number; requestedCents: number };
    const id = createApplication(db, body);
    return reply.status(201).send({ id });
  });

  app.post('/applications/:id/transition', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { to } = req.body as { to: ApplicationStatus };
    transitionApplication(db, Number(id), to);
    return reply.status(200).send({ id: Number(id), status: to });
  });

  app.post('/awards', async (req, reply) => {
    const body = req.body as {
      applicationId: number;
      awardedCents: number;
      periodStart: string;
      periodEnd: string;
    };
    const id = createAward(db, body);
    return reply.status(201).send({ id });
  });

  app.post('/awards/:id/budget-lines', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { category: never; amountCents: number };
    const lineId = addBudgetLine(db, { awardId: Number(id), ...body });
    return reply.status(201).send({ id: lineId });
  });

  app.post('/budget-lines/:id/expenditures', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { amountCents: number; spentOn: string; description: string };
    const expId = recordExpenditure(db, { budgetLineId: Number(id), ...body });
    return reply.status(201).send({ id: expId });
  });

  app.post('/plans', async (req, reply) => {
    const body = req.body as { entityId: number; fiscalYear: number; title: string };
    const id = createPlan(db, body);
    return reply.status(201).send({ id });
  });

  app.post('/plans/:id/adopt', async (req, reply) => {
    const { id } = req.params as { id: string };
    adoptPlan(db, Number(id));
    return reply.status(200).send({ id: Number(id), status: 'adopted' });
  });

  app.post('/plans/:id/goals', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { ordinal: number; statement: string };
    const goalId = addGoal(db, { planId: Number(id), ...body });
    return reply.status(201).send({ id: goalId });
  });

  app.post('/goals/:id/strategies', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { ordinal: number; description: string };
    const strategyId = addStrategy(db, { goalId: Number(id), ...body });
    return reply.status(201).send({ id: strategyId });
  });

  app.post('/strategies/:id/funding', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { awardId: number; plannedCents: number };
    const fundingId = fundStrategy(db, { strategyId: Number(id), ...body });
    return reply.status(201).send({ id: fundingId });
  });

  app.post('/metrics', async (req, reply) => {
    const body = req.body as { code: string; name: string; unit: never; direction: never };
    const id = createMetric(db, body);
    return reply.status(201).send({ id });
  });

  app.post('/goals/:id/targets', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { metricId: number; baselineValue: number; targetValue: number; dueFiscalYear: number };
    const targetId = addTarget(db, { goalId: Number(id), ...body });
    return reply.status(201).send({ id: targetId });
  });

  app.post('/readings', async (req, reply) => {
    const body = req.body as { metricId: number; entityId: number; period: string; value: number; source: string };
    const id = recordReading(db, body);
    return reply.status(201).send({ id });
  });

  app.get('/plans/:id/performance', async (req) => {
    const { id } = req.params as { id: string };
    return planPerformance(db, Number(id));
  });

  app.get('/reports/funding-impact', async () => fundingImpact(db));

  return app;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const dbPath = fileURLToPath(new URL('../../data/grantweave.db', import.meta.url));
  if (!existsSync(dbPath)) {
    console.error('No database found. Run "npm run seed" first.');
    process.exit(1);
  }
  const server = buildServer(openDb(dbPath));
  const port = Number(process.env.PORT ?? 3000);
  server.listen({ port, host: '127.0.0.1' }).then(() => {
    console.log(`grantweave API listening on http://127.0.0.1:${port}`);
  });
}
