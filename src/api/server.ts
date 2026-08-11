import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../db.js';
import { DomainError } from '../domain/errors.js';
import {
  createFundingSource,
  createGrant,
  createMetric,
  type MetricDirection,
  type MetricUnit,
  type Origin,
} from '../domain/catalog.js';
import { createEntity, type EntityKind } from '../domain/entities.js';
import {
  addBudgetLine,
  createApplication,
  createAward,
  recordExpenditure,
  transitionApplication,
  type ApplicationStatus,
  type BudgetCategory,
} from '../domain/lifecycle.js';
import { addGoal, addStrategy, adoptPlan, createPlan, fundStrategy } from '../domain/planning.js';
import { addTarget, recordReading } from '../domain/performance.js';
import {
  entityFundingSummary,
  fundingImpact,
  grantUtilization,
  planPerformance,
} from '../reports/rollups.js';

const cents = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const centsOrZero = { ...cents, minimum: 0 };
const isoDate = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const nonEmpty = { type: 'string', minLength: 1 };
const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
};

function body(required: string[], properties: Record<string, unknown>) {
  return { type: 'object', required, properties, additionalProperties: false };
}

export function buildServer(db: DatabaseSync, options: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof DomainError) {
      return reply.status(err.status).send({ error: err.code, message: err.message });
    }
    if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: 'bad_request', message: err.message });
    }
    app.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'unexpected server error' });
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/funding-sources', async () =>
    db.prepare('SELECT id, code, name, origin, active FROM funding_sources ORDER BY id').all(),
  );

  app.post(
    '/funding-sources',
    {
      schema: {
        body: body(['code', 'name', 'origin'], {
          code: nonEmpty,
          name: nonEmpty,
          origin: { enum: ['federal', 'state', 'local', 'private'] },
        }),
      },
    },
    async (req, reply) => {
      const input = req.body as { code: string; name: string; origin: Origin };
      return reply.status(201).send({ id: createFundingSource(db, input) });
    },
  );

  app.get('/grants', async () =>
    db
      .prepare(
        'SELECT id, funding_source_id, code, title, fiscal_year, appropriation_cents, status FROM grants ORDER BY id',
      )
      .all(),
  );

  app.post(
    '/grants',
    {
      schema: {
        body: body(['fundingSourceId', 'code', 'title', 'fiscalYear', 'appropriationCents'], {
          fundingSourceId: { type: 'integer', minimum: 1 },
          code: nonEmpty,
          title: nonEmpty,
          fiscalYear: { type: 'integer', minimum: 2000, maximum: 2100 },
          appropriationCents: centsOrZero,
        }),
      },
    },
    async (req, reply) => {
      const input = req.body as {
        fundingSourceId: number;
        code: string;
        title: string;
        fiscalYear: number;
        appropriationCents: number;
      };
      return reply.status(201).send({ id: createGrant(db, input) });
    },
  );

  app.get('/grants/:id/utilization', { schema: { params: idParams } }, async (req) => {
    const { id } = req.params as { id: number };
    return grantUtilization(db, id);
  });

  app.get('/entities', async () =>
    db.prepare('SELECT id, parent_id, kind, name, local_code, active FROM entities ORDER BY id').all(),
  );

  app.post(
    '/entities',
    {
      schema: {
        body: body(['kind', 'name', 'localCode'], {
          kind: { enum: ['service_center', 'district', 'charter', 'campus'] },
          name: nonEmpty,
          localCode: nonEmpty,
          parentId: { type: 'integer', minimum: 1 },
        }),
      },
    },
    async (req, reply) => {
      const input = req.body as { kind: EntityKind; name: string; localCode: string; parentId?: number };
      return reply.status(201).send({ id: createEntity(db, input) });
    },
  );

  app.get('/entities/:id/funding-summary', { schema: { params: idParams } }, async (req) => {
    const { id } = req.params as { id: number };
    return entityFundingSummary(db, id);
  });

  app.post(
    '/applications',
    {
      schema: {
        body: body(['grantId', 'entityId', 'requestedCents'], {
          grantId: { type: 'integer', minimum: 1 },
          entityId: { type: 'integer', minimum: 1 },
          requestedCents: cents,
        }),
      },
    },
    async (req, reply) => {
      const input = req.body as { grantId: number; entityId: number; requestedCents: number };
      return reply.status(201).send({ id: createApplication(db, input) });
    },
  );

  app.post(
    '/applications/:id/transition',
    {
      schema: {
        params: idParams,
        body: body(['to'], {
          to: { enum: ['submitted', 'under_review', 'approved', 'rejected', 'withdrawn'] },
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const { to } = req.body as { to: ApplicationStatus };
      transitionApplication(db, id, to);
      return reply.status(200).send({ id, status: to });
    },
  );

  app.post(
    '/awards',
    {
      schema: {
        body: body(['applicationId', 'awardedCents', 'periodStart', 'periodEnd'], {
          applicationId: { type: 'integer', minimum: 1 },
          awardedCents: cents,
          periodStart: isoDate,
          periodEnd: isoDate,
        }),
      },
    },
    async (req, reply) => {
      const input = req.body as {
        applicationId: number;
        awardedCents: number;
        periodStart: string;
        periodEnd: string;
      };
      return reply.status(201).send({ id: createAward(db, input) });
    },
  );

  app.post(
    '/awards/:id/budget-lines',
    {
      schema: {
        params: idParams,
        body: body(['category', 'amountCents'], {
          category: {
            enum: ['payroll', 'professional_services', 'supplies', 'other_operating', 'capital_outlay'],
          },
          amountCents: cents,
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const input = req.body as { category: BudgetCategory; amountCents: number };
      return reply.status(201).send({ id: addBudgetLine(db, { awardId: id, ...input }) });
    },
  );

  app.post(
    '/budget-lines/:id/expenditures',
    {
      schema: {
        params: idParams,
        body: body(['amountCents', 'spentOn', 'description'], {
          amountCents: cents,
          spentOn: isoDate,
          description: nonEmpty,
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const input = req.body as { amountCents: number; spentOn: string; description: string };
      return reply.status(201).send({ id: recordExpenditure(db, { budgetLineId: id, ...input }) });
    },
  );

  app.post(
    '/plans',
    {
      schema: {
        body: body(['entityId', 'fiscalYear', 'title'], {
          entityId: { type: 'integer', minimum: 1 },
          fiscalYear: { type: 'integer', minimum: 2000, maximum: 2100 },
          title: nonEmpty,
        }),
      },
    },
    async (req, reply) => {
      const input = req.body as { entityId: number; fiscalYear: number; title: string };
      return reply.status(201).send({ id: createPlan(db, input) });
    },
  );

  app.post('/plans/:id/adopt', { schema: { params: idParams } }, async (req, reply) => {
    const { id } = req.params as { id: number };
    adoptPlan(db, id);
    return reply.status(200).send({ id, status: 'adopted' });
  });

  app.post(
    '/plans/:id/goals',
    {
      schema: {
        params: idParams,
        body: body(['ordinal', 'statement'], {
          ordinal: { type: 'integer', minimum: 1 },
          statement: nonEmpty,
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const input = req.body as { ordinal: number; statement: string };
      return reply.status(201).send({ id: addGoal(db, { planId: id, ...input }) });
    },
  );

  app.post(
    '/goals/:id/strategies',
    {
      schema: {
        params: idParams,
        body: body(['ordinal', 'description'], {
          ordinal: { type: 'integer', minimum: 1 },
          description: nonEmpty,
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const input = req.body as { ordinal: number; description: string };
      return reply.status(201).send({ id: addStrategy(db, { goalId: id, ...input }) });
    },
  );

  app.post(
    '/strategies/:id/funding',
    {
      schema: {
        params: idParams,
        body: body(['awardId', 'plannedCents'], {
          awardId: { type: 'integer', minimum: 1 },
          plannedCents: cents,
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const input = req.body as { awardId: number; plannedCents: number };
      return reply.status(201).send({ id: fundStrategy(db, { strategyId: id, ...input }) });
    },
  );

  app.post(
    '/metrics',
    {
      schema: {
        body: body(['code', 'name', 'unit', 'direction'], {
          code: nonEmpty,
          name: nonEmpty,
          unit: { enum: ['percent', 'count', 'currency', 'ratio'] },
          direction: { enum: ['increase', 'decrease'] },
        }),
      },
    },
    async (req, reply) => {
      const input = req.body as { code: string; name: string; unit: MetricUnit; direction: MetricDirection };
      return reply.status(201).send({ id: createMetric(db, input) });
    },
  );

  app.post(
    '/goals/:id/targets',
    {
      schema: {
        params: idParams,
        body: body(['metricId', 'baselineValue', 'targetValue', 'dueFiscalYear'], {
          metricId: { type: 'integer', minimum: 1 },
          baselineValue: { type: 'number' },
          targetValue: { type: 'number' },
          dueFiscalYear: { type: 'integer', minimum: 2000, maximum: 2100 },
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const input = req.body as {
        metricId: number;
        baselineValue: number;
        targetValue: number;
        dueFiscalYear: number;
      };
      return reply.status(201).send({ id: addTarget(db, { goalId: id, ...input }) });
    },
  );

  app.post(
    '/readings',
    {
      schema: {
        body: body(['metricId', 'entityId', 'period', 'value', 'source'], {
          metricId: { type: 'integer', minimum: 1 },
          entityId: { type: 'integer', minimum: 1 },
          period: isoDate,
          value: { type: 'number' },
          source: nonEmpty,
        }),
      },
    },
    async (req, reply) => {
      const input = req.body as {
        metricId: number;
        entityId: number;
        period: string;
        value: number;
        source: string;
      };
      return reply.status(201).send({ id: recordReading(db, input) });
    },
  );

  app.get('/plans/:id/performance', { schema: { params: idParams } }, async (req) => {
    const { id } = req.params as { id: number };
    return planPerformance(db, id);
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
  const server = buildServer(openDb(dbPath), { logger: true });
  const port = Number(process.env.PORT ?? 3000);
  server.listen({ port, host: '127.0.0.1' }).then(() => {
    console.log(`grantweave API listening on http://127.0.0.1:${port}`);
  });
}
