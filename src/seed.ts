import { mkdirSync, rmSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.js';
import { createFundingSource, createGrant, createMetric } from './domain/catalog.js';
import { createEntity } from './domain/entities.js';
import {
  addBudgetLine,
  createApplication,
  createAward,
  recordExpenditure,
  transitionApplication,
} from './domain/lifecycle.js';
import { addGoal, addStrategy, adoptPlan, createPlan, fundStrategy } from './domain/planning.js';
import { addTarget, recordReading } from './domain/performance.js';

export interface SeedIds {
  bluebonnetIsd: number;
  bluebonnetHigh: number;
  prairieCreekElem: number;
  rioVerdeIsd: number;
  rioVerdeMiddle: number;
  esserGrant: number;
  title1Grant: number;
  sceGrant: number;
  esserAward: number;
  title1Award: number;
  sceAward: number;
  bluebonnetPlan: number;
  readingMetric: number;
  attendanceMetric: number;
}

export function seedDemo(db: DatabaseSync): SeedIds {
  const esser = createFundingSource(db, {
    code: 'ESSER-III',
    name: 'Elementary and Secondary School Emergency Relief III',
    origin: 'federal',
  });
  const title1 = createFundingSource(db, { code: 'TITLE1A', name: 'Title I, Part A', origin: 'federal' });
  const sce = createFundingSource(db, {
    code: 'SCE',
    name: 'State Compensatory Education',
    origin: 'state',
  });

  const esserGrant = createGrant(db, {
    fundingSourceId: esser,
    code: 'G-ESSER3-26',
    title: 'ESSER III LEA Allocation FY2026',
    fiscalYear: 2026,
    appropriationCents: 200_000_000,
  });
  const title1Grant = createGrant(db, {
    fundingSourceId: title1,
    code: 'G-T1A-26',
    title: 'Title I, Part A Campus Support FY2026',
    fiscalYear: 2026,
    appropriationCents: 150_000_000,
  });
  const sceGrant = createGrant(db, {
    fundingSourceId: sce,
    code: 'G-SCE-26',
    title: 'State Compensatory Education FY2026',
    fiscalYear: 2026,
    appropriationCents: 100_000_000,
  });

  const bluebonnetIsd = createEntity(db, { kind: 'district', name: 'Bluebonnet ISD', localCode: '901-901' });
  const bluebonnetHigh = createEntity(db, {
    kind: 'campus',
    name: 'Bluebonnet High School',
    localCode: '901-901-001',
    parentId: bluebonnetIsd,
  });
  const prairieCreekElem = createEntity(db, {
    kind: 'campus',
    name: 'Prairie Creek Elementary',
    localCode: '901-901-102',
    parentId: bluebonnetIsd,
  });
  const rioVerdeIsd = createEntity(db, { kind: 'district', name: 'Rio Verde ISD', localCode: '902-902' });
  const rioVerdeMiddle = createEntity(db, {
    kind: 'campus',
    name: 'Rio Verde Middle School',
    localCode: '902-902-041',
    parentId: rioVerdeIsd,
  });

  const esserApp = createApplication(db, {
    grantId: esserGrant,
    entityId: bluebonnetIsd,
    requestedCents: 50_000_000,
  });
  transitionApplication(db, esserApp, 'submitted');
  transitionApplication(db, esserApp, 'under_review');
  transitionApplication(db, esserApp, 'approved');
  const esserAward = createAward(db, {
    applicationId: esserApp,
    awardedCents: 45_000_000,
    periodStart: '2025-09-01',
    periodEnd: '2026-08-31',
  });
  const esserPayroll = addBudgetLine(db, { awardId: esserAward, category: 'payroll', amountCents: 25_000_000 });
  const esserServices = addBudgetLine(db, {
    awardId: esserAward,
    category: 'professional_services',
    amountCents: 12_000_000,
  });
  const esserSupplies = addBudgetLine(db, { awardId: esserAward, category: 'supplies', amountCents: 5_000_000 });
  recordExpenditure(db, {
    budgetLineId: esserPayroll,
    amountCents: 6_000_000,
    spentOn: '2025-10-15',
    description: 'Reading interventionist salaries, Q1',
  });
  recordExpenditure(db, {
    budgetLineId: esserPayroll,
    amountCents: 6_000_000,
    spentOn: '2026-01-15',
    description: 'Reading interventionist salaries, Q2',
  });
  recordExpenditure(db, {
    budgetLineId: esserServices,
    amountCents: 3_500_000,
    spentOn: '2025-11-20',
    description: 'High-dosage tutoring vendor, fall term',
  });
  recordExpenditure(db, {
    budgetLineId: esserSupplies,
    amountCents: 1_200_000,
    spentOn: '2025-09-30',
    description: 'Decodable readers and classroom libraries',
  });

  const title1App = createApplication(db, {
    grantId: title1Grant,
    entityId: prairieCreekElem,
    requestedCents: 20_000_000,
  });
  transitionApplication(db, title1App, 'submitted');
  transitionApplication(db, title1App, 'under_review');
  transitionApplication(db, title1App, 'approved');
  const title1Award = createAward(db, {
    applicationId: title1App,
    awardedCents: 18_000_000,
    periodStart: '2025-09-01',
    periodEnd: '2026-08-31',
  });
  const title1Payroll = addBudgetLine(db, { awardId: title1Award, category: 'payroll', amountCents: 12_000_000 });
  const title1Supplies = addBudgetLine(db, { awardId: title1Award, category: 'supplies', amountCents: 3_000_000 });
  recordExpenditure(db, {
    budgetLineId: title1Payroll,
    amountCents: 3_000_000,
    spentOn: '2025-12-10',
    description: 'Attendance outreach coordinator, fall term',
  });
  recordExpenditure(db, {
    budgetLineId: title1Supplies,
    amountCents: 800_000,
    spentOn: '2025-10-05',
    description: 'Family engagement materials',
  });

  const sceApp = createApplication(db, {
    grantId: sceGrant,
    entityId: rioVerdeIsd,
    requestedCents: 30_000_000,
  });
  transitionApplication(db, sceApp, 'submitted');
  transitionApplication(db, sceApp, 'under_review');
  transitionApplication(db, sceApp, 'approved');
  const sceAward = createAward(db, {
    applicationId: sceApp,
    awardedCents: 30_000_000,
    periodStart: '2025-09-01',
    periodEnd: '2026-08-31',
  });
  const scePayroll = addBudgetLine(db, { awardId: sceAward, category: 'payroll', amountCents: 20_000_000 });
  recordExpenditure(db, {
    budgetLineId: scePayroll,
    amountCents: 5_000_000,
    spentOn: '2025-11-01',
    description: 'Accelerated instruction staffing, fall term',
  });

  const pendingApp = createApplication(db, {
    grantId: title1Grant,
    entityId: rioVerdeMiddle,
    requestedCents: 15_000_000,
  });
  transitionApplication(db, pendingApp, 'submitted');
  transitionApplication(db, pendingApp, 'under_review');

  const readingMetric = createMetric(db, {
    code: 'reading_meets_pct',
    name: 'Grades 3-5 reading: percent at Meets or above',
    unit: 'percent',
    direction: 'increase',
  });
  const attendanceMetric = createMetric(db, {
    code: 'attendance_rate',
    name: 'Average daily attendance rate',
    unit: 'percent',
    direction: 'increase',
  });

  const bluebonnetPlan = createPlan(db, {
    entityId: bluebonnetIsd,
    fiscalYear: 2026,
    title: 'Bluebonnet ISD District Improvement Plan',
  });
  const readingGoal = addGoal(db, {
    planId: bluebonnetPlan,
    ordinal: 1,
    statement: 'Raise grades 3-5 reading proficiency to 55% at Meets or above by end of FY2026',
  });
  const tutoring = addStrategy(db, {
    goalId: readingGoal,
    ordinal: 1,
    description: 'High-dosage reading tutoring at Title I campuses',
  });
  const extendedDay = addStrategy(db, {
    goalId: readingGoal,
    ordinal: 2,
    description: 'Extended-day literacy program with certified interventionists',
  });
  const attendanceGoal = addGoal(db, {
    planId: bluebonnetPlan,
    ordinal: 2,
    statement: 'Raise average daily attendance to 95% by end of FY2026',
  });
  const outreach = addStrategy(db, {
    goalId: attendanceGoal,
    ordinal: 1,
    description: 'Campus attendance outreach team with weekly family contact',
  });
  adoptPlan(db, bluebonnetPlan);

  fundStrategy(db, { strategyId: tutoring, awardId: esserAward, plannedCents: 15_000_000 });
  fundStrategy(db, { strategyId: extendedDay, awardId: esserAward, plannedCents: 10_000_000 });
  fundStrategy(db, { strategyId: outreach, awardId: title1Award, plannedCents: 4_000_000 });

  addTarget(db, {
    goalId: readingGoal,
    metricId: readingMetric,
    baselineValue: 42.0,
    targetValue: 55.0,
    dueFiscalYear: 2026,
  });
  addTarget(db, {
    goalId: attendanceGoal,
    metricId: attendanceMetric,
    baselineValue: 91.5,
    targetValue: 95.0,
    dueFiscalYear: 2026,
  });

  recordReading(db, { metricId: readingMetric, entityId: bluebonnetIsd, period: '2025-05-30', value: 42.0, source: 'district interim assessment' });
  recordReading(db, { metricId: readingMetric, entityId: bluebonnetIsd, period: '2026-01-15', value: 47.5, source: 'district interim assessment' });
  recordReading(db, { metricId: readingMetric, entityId: bluebonnetIsd, period: '2026-05-29', value: 51.0, source: 'district interim assessment' });
  recordReading(db, { metricId: attendanceMetric, entityId: bluebonnetIsd, period: '2025-05-30', value: 91.5, source: 'attendance system export' });
  recordReading(db, { metricId: attendanceMetric, entityId: bluebonnetIsd, period: '2026-01-15', value: 93.2, source: 'attendance system export' });
  recordReading(db, { metricId: attendanceMetric, entityId: bluebonnetIsd, period: '2026-05-29', value: 94.1, source: 'attendance system export' });

  return {
    bluebonnetIsd,
    bluebonnetHigh,
    prairieCreekElem,
    rioVerdeIsd,
    rioVerdeMiddle,
    esserGrant,
    title1Grant,
    sceGrant,
    esserAward,
    title1Award,
    sceAward,
    bluebonnetPlan,
    readingMetric,
    attendanceMetric,
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const dbPath = fileURLToPath(new URL('../data/grantweave.db', import.meta.url));
  rmSync(dbPath, { force: true });
  mkdirSync(fileURLToPath(new URL('../data', import.meta.url)), { recursive: true });
  const db = openDb(dbPath);
  seedDemo(db);
  db.close();
  console.log(`Seeded demo data into ${dbPath}`);
}
