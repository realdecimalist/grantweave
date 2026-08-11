CREATE TABLE IF NOT EXISTS funding_sources (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('federal', 'state', 'local', 'private')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS grants (
  id INTEGER PRIMARY KEY,
  funding_source_id INTEGER NOT NULL REFERENCES funding_sources(id),
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  appropriation_cents INTEGER NOT NULL CHECK (appropriation_cents >= 0 AND typeof(appropriation_cents) = 'integer'),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('planned', 'open', 'closed', 'archived'))
);

CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES entities(id),
  kind TEXT NOT NULL CHECK (kind IN ('service_center', 'district', 'charter', 'campus')),
  name TEXT NOT NULL,
  local_code TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY,
  grant_id INTEGER NOT NULL REFERENCES grants(id),
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  requested_cents INTEGER NOT NULL CHECK (requested_cents > 0 AND typeof(requested_cents) = 'integer'),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'withdrawn')),
  submitted_at TEXT,
  UNIQUE (grant_id, entity_id)
);

CREATE TABLE IF NOT EXISTS awards (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL UNIQUE REFERENCES applications(id),
  awarded_cents INTEGER NOT NULL CHECK (awarded_cents > 0 AND typeof(awarded_cents) = 'integer'),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  CHECK (period_end > period_start)
);

CREATE TABLE IF NOT EXISTS budget_lines (
  id INTEGER PRIMARY KEY,
  award_id INTEGER NOT NULL REFERENCES awards(id),
  category TEXT NOT NULL
    CHECK (category IN ('payroll', 'professional_services', 'supplies', 'other_operating', 'capital_outlay')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0 AND typeof(amount_cents) = 'integer'),
  UNIQUE (award_id, category)
);

CREATE TABLE IF NOT EXISTS expenditures (
  id INTEGER PRIMARY KEY,
  budget_line_id INTEGER NOT NULL REFERENCES budget_lines(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0 AND typeof(amount_cents) = 'integer'),
  spent_on TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  fiscal_year INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'adopted', 'retired')),
  UNIQUE (entity_id, fiscal_year)
);

CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  ordinal INTEGER NOT NULL,
  statement TEXT NOT NULL,
  UNIQUE (plan_id, ordinal)
);

CREATE TABLE IF NOT EXISTS strategies (
  id INTEGER PRIMARY KEY,
  goal_id INTEGER NOT NULL REFERENCES goals(id),
  ordinal INTEGER NOT NULL,
  description TEXT NOT NULL,
  UNIQUE (goal_id, ordinal)
);

CREATE TABLE IF NOT EXISTS strategy_funding (
  id INTEGER PRIMARY KEY,
  strategy_id INTEGER NOT NULL REFERENCES strategies(id),
  award_id INTEGER NOT NULL REFERENCES awards(id),
  planned_cents INTEGER NOT NULL CHECK (planned_cents > 0 AND typeof(planned_cents) = 'integer'),
  UNIQUE (strategy_id, award_id)
);

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('percent', 'count', 'currency', 'ratio')),
  direction TEXT NOT NULL CHECK (direction IN ('increase', 'decrease'))
);

CREATE TABLE IF NOT EXISTS targets (
  id INTEGER PRIMARY KEY,
  goal_id INTEGER NOT NULL REFERENCES goals(id),
  metric_id INTEGER NOT NULL REFERENCES metrics(id),
  baseline_value REAL NOT NULL,
  target_value REAL NOT NULL,
  due_fiscal_year INTEGER NOT NULL,
  UNIQUE (goal_id, metric_id),
  CHECK (target_value <> baseline_value)
);

CREATE TABLE IF NOT EXISTS readings (
  id INTEGER PRIMARY KEY,
  metric_id INTEGER NOT NULL REFERENCES metrics(id),
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  period TEXT NOT NULL,
  value REAL NOT NULL,
  source TEXT NOT NULL,
  UNIQUE (metric_id, entity_id, period)
);

CREATE INDEX IF NOT EXISTS idx_applications_entity ON applications(entity_id);
CREATE INDEX IF NOT EXISTS idx_budget_lines_award ON budget_lines(award_id);
CREATE INDEX IF NOT EXISTS idx_expenditures_line ON expenditures(budget_line_id);
CREATE INDEX IF NOT EXISTS idx_strategy_funding_award ON strategy_funding(award_id);
CREATE INDEX IF NOT EXISTS idx_readings_lookup ON readings(metric_id, entity_id, period);
