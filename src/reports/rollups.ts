import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../domain/errors.js';
import { progressToTarget } from '../domain/performance.js';

export interface FundingSummaryRow {
  origin: string;
  award_count: number;
  awarded_cents: number;
  budgeted_cents: number;
  spent_cents: number;
  remaining_cents: number;
}

export function entityFundingSummary(db: DatabaseSync, entityId: number): FundingSummaryRow[] {
  const entity = db.prepare('SELECT id FROM entities WHERE id = ?').get(entityId);
  if (!entity) throw new DomainError('not_found', `entity ${entityId} not found`);
  return db
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM entities WHERE id = ?
         UNION ALL
         SELECT e.id FROM entities e JOIN tree ON e.parent_id = tree.id
       ),
       award_rollup AS (
         SELECT
           g.funding_source_id,
           aw.awarded_cents,
           COALESCE((SELECT SUM(bl.amount_cents) FROM budget_lines bl WHERE bl.award_id = aw.id), 0) AS budgeted_cents,
           COALESCE((SELECT SUM(x.amount_cents)
                     FROM expenditures x JOIN budget_lines bl ON bl.id = x.budget_line_id
                     WHERE bl.award_id = aw.id), 0) AS spent_cents
         FROM awards aw
         JOIN applications ap ON ap.id = aw.application_id
         JOIN grants g ON g.id = ap.grant_id
         WHERE ap.entity_id IN (SELECT id FROM tree)
       )
       SELECT
         fs.origin,
         COUNT(*) AS award_count,
         SUM(ar.awarded_cents) AS awarded_cents,
         SUM(ar.budgeted_cents) AS budgeted_cents,
         SUM(ar.spent_cents) AS spent_cents,
         SUM(ar.awarded_cents) - SUM(ar.spent_cents) AS remaining_cents
       FROM award_rollup ar
       JOIN funding_sources fs ON fs.id = ar.funding_source_id
       GROUP BY fs.origin
       ORDER BY fs.origin`,
    )
    .all(entityId) as unknown as FundingSummaryRow[];
}

export interface GrantUtilization {
  grant_code: string;
  title: string;
  appropriation_cents: number;
  application_count: number;
  requested_cents: number;
  awarded_cents: number;
  budgeted_cents: number;
  spent_cents: number;
  unawarded_appropriation_cents: number;
}

export function grantUtilization(db: DatabaseSync, grantId: number): GrantUtilization {
  const row = db
    .prepare(
      `SELECT
         g.code AS grant_code,
         g.title,
         g.appropriation_cents,
         COUNT(ap.id) AS application_count,
         COALESCE(SUM(ap.requested_cents), 0) AS requested_cents,
         COALESCE(SUM(aw.awarded_cents), 0) AS awarded_cents,
         COALESCE(SUM((SELECT SUM(bl.amount_cents) FROM budget_lines bl WHERE bl.award_id = aw.id)), 0) AS budgeted_cents,
         COALESCE(SUM((SELECT SUM(x.amount_cents)
                       FROM expenditures x JOIN budget_lines bl ON bl.id = x.budget_line_id
                       WHERE bl.award_id = aw.id)), 0) AS spent_cents
       FROM grants g
       LEFT JOIN applications ap ON ap.grant_id = g.id
       LEFT JOIN awards aw ON aw.application_id = ap.id
       WHERE g.id = ?
       GROUP BY g.id`,
    )
    .get(grantId) as unknown as GrantUtilization | undefined;
  if (!row) throw new DomainError('not_found', `grant ${grantId} not found`);
  row.unawarded_appropriation_cents = row.appropriation_cents - row.awarded_cents;
  return row;
}

export interface PlanPerformance {
  plan_id: number;
  entity_name: string;
  fiscal_year: number;
  title: string;
  status: string;
  goals: Array<{
    goal_id: number;
    ordinal: number;
    statement: string;
    funded_cents: number;
    strategies: Array<{
      ordinal: number;
      description: string;
      funding: Array<{ grant_code: string; funding_source: string; planned_cents: number }>;
    }>;
    targets: Array<{
      metric_code: string;
      metric_name: string;
      unit: string;
      direction: string;
      baseline_value: number;
      target_value: number;
      latest_value: number | null;
      latest_period: string | null;
      progress: number | null;
    }>;
  }>;
}

export function planPerformance(db: DatabaseSync, planId: number): PlanPerformance {
  const plan = db
    .prepare(
      `SELECT p.id AS plan_id, e.name AS entity_name, e.id AS entity_id, p.fiscal_year, p.title, p.status
       FROM plans p JOIN entities e ON e.id = p.entity_id
       WHERE p.id = ?`,
    )
    .get(planId) as
    | { plan_id: number; entity_name: string; entity_id: number; fiscal_year: number; title: string; status: string }
    | undefined;
  if (!plan) throw new DomainError('not_found', `plan ${planId} not found`);

  const goals = db
    .prepare('SELECT id AS goal_id, ordinal, statement FROM goals WHERE plan_id = ? ORDER BY ordinal')
    .all(planId) as unknown as Array<{ goal_id: number; ordinal: number; statement: string }>;

  const strategyRows = db
    .prepare(
      `SELECT s.goal_id, s.ordinal, s.description, g.code AS grant_code, fs.name AS funding_source, sf.planned_cents
       FROM strategies s
       LEFT JOIN strategy_funding sf ON sf.strategy_id = s.id
       LEFT JOIN awards aw ON aw.id = sf.award_id
       LEFT JOIN applications ap ON ap.id = aw.application_id
       LEFT JOIN grants g ON g.id = ap.grant_id
       LEFT JOIN funding_sources fs ON fs.id = g.funding_source_id
       WHERE s.goal_id IN (SELECT id FROM goals WHERE plan_id = ?)
       ORDER BY s.goal_id, s.ordinal`,
    )
    .all(planId) as unknown as Array<{
    goal_id: number;
    ordinal: number;
    description: string;
    grant_code: string | null;
    funding_source: string | null;
    planned_cents: number | null;
  }>;

  const targetRows = db
    .prepare(
      `SELECT t.goal_id, m.code AS metric_code, m.name AS metric_name, m.unit, m.direction,
              t.baseline_value, t.target_value,
              (SELECT r.value FROM readings r
               WHERE r.metric_id = t.metric_id AND r.entity_id = ?
               ORDER BY r.period DESC LIMIT 1) AS latest_value,
              (SELECT r.period FROM readings r
               WHERE r.metric_id = t.metric_id AND r.entity_id = ?
               ORDER BY r.period DESC LIMIT 1) AS latest_period
       FROM targets t JOIN metrics m ON m.id = t.metric_id
       WHERE t.goal_id IN (SELECT id FROM goals WHERE plan_id = ?)`,
    )
    .all(plan.entity_id, plan.entity_id, planId) as unknown as Array<{
    goal_id: number;
    metric_code: string;
    metric_name: string;
    unit: string;
    direction: string;
    baseline_value: number;
    target_value: number;
    latest_value: number | null;
    latest_period: string | null;
  }>;

  return {
    plan_id: plan.plan_id,
    entity_name: plan.entity_name,
    fiscal_year: plan.fiscal_year,
    title: plan.title,
    status: plan.status,
    goals: goals.map((goal) => {
      const strategies = new Map<number, PlanPerformance['goals'][number]['strategies'][number]>();
      let fundedCents = 0;
      for (const row of strategyRows.filter((r) => r.goal_id === goal.goal_id)) {
        let entry = strategies.get(row.ordinal);
        if (!entry) {
          entry = { ordinal: row.ordinal, description: row.description, funding: [] };
          strategies.set(row.ordinal, entry);
        }
        if (row.grant_code !== null && row.funding_source !== null && row.planned_cents !== null) {
          entry.funding.push({
            grant_code: row.grant_code,
            funding_source: row.funding_source,
            planned_cents: row.planned_cents,
          });
          fundedCents += row.planned_cents;
        }
      }
      return {
        goal_id: goal.goal_id,
        ordinal: goal.ordinal,
        statement: goal.statement,
        funded_cents: fundedCents,
        strategies: [...strategies.values()],
        targets: targetRows
          .filter((t) => t.goal_id === goal.goal_id)
          .map((t) => ({
            metric_code: t.metric_code,
            metric_name: t.metric_name,
            unit: t.unit,
            direction: t.direction,
            baseline_value: t.baseline_value,
            target_value: t.target_value,
            latest_value: t.latest_value,
            latest_period: t.latest_period,
            progress:
              t.latest_value === null
                ? null
                : progressToTarget(t.baseline_value, t.target_value, t.latest_value),
          })),
      };
    }),
  };
}

export interface FundingImpactRow {
  funding_source: string;
  funding_source_name: string;
  metric_code: string;
  metric_name: string;
  unit: string;
  direction: string;
  entity_name: string;
  plan_title: string;
  funded_cents: number;
  baseline_value: number;
  target_value: number;
  latest_value: number | null;
  progress: number | null;
}

export function fundingImpact(db: DatabaseSync): FundingImpactRow[] {
  const rows = db
    .prepare(
      `SELECT
         fs.code AS funding_source,
         fs.name AS funding_source_name,
         m.code AS metric_code,
         m.name AS metric_name,
         m.unit,
         m.direction,
         e.name AS entity_name,
         p.title AS plan_title,
         SUM(sf.planned_cents) AS funded_cents,
         t.baseline_value,
         t.target_value,
         (SELECT r.value FROM readings r
          WHERE r.metric_id = t.metric_id AND r.entity_id = p.entity_id
          ORDER BY r.period DESC LIMIT 1) AS latest_value
       FROM strategy_funding sf
       JOIN awards aw ON aw.id = sf.award_id
       JOIN applications ap ON ap.id = aw.application_id
       JOIN grants g ON g.id = ap.grant_id
       JOIN funding_sources fs ON fs.id = g.funding_source_id
       JOIN strategies s ON s.id = sf.strategy_id
       JOIN goals go ON go.id = s.goal_id
       JOIN plans p ON p.id = go.plan_id
       JOIN entities e ON e.id = p.entity_id
       JOIN targets t ON t.goal_id = go.id
       JOIN metrics m ON m.id = t.metric_id
       GROUP BY fs.id, t.id
       ORDER BY fs.code, m.code`,
    )
    .all() as unknown as Array<Omit<FundingImpactRow, 'progress'>>;
  return rows.map((row) => ({
    ...row,
    progress:
      row.latest_value === null
        ? null
        : progressToTarget(row.baseline_value, row.target_value, row.latest_value),
  }));
}
