import type { DatabaseSync } from 'node:sqlite';
import { lastId } from '../db.js';
import { DomainError, rethrowUnique } from './errors.js';

export type EntityKind = 'service_center' | 'district' | 'charter' | 'campus';

const VALID_PARENT_KINDS: Record<EntityKind, EntityKind[] | null> = {
  service_center: null,
  district: ['service_center'],
  charter: ['service_center'],
  campus: ['district', 'charter'],
};

export function createEntity(
  db: DatabaseSync,
  input: { kind: EntityKind; name: string; localCode: string; parentId?: number },
): number {
  const allowedParents = VALID_PARENT_KINDS[input.kind];
  if (input.parentId !== undefined) {
    if (allowedParents === null) {
      throw new DomainError('validation', `a ${input.kind} cannot have a parent entity`);
    }
    const parent = db.prepare('SELECT kind FROM entities WHERE id = ?').get(input.parentId) as
      | { kind: EntityKind }
      | undefined;
    if (!parent) throw new DomainError('not_found', `parent entity ${input.parentId} not found`);
    if (!allowedParents.includes(parent.kind)) {
      throw new DomainError(
        'validation',
        `a ${input.kind} cannot belong to a ${parent.kind}; allowed parents: ${allowedParents.join(', ')}`,
      );
    }
  } else if (input.kind === 'campus') {
    throw new DomainError('validation', 'a campus requires a district or charter parent');
  }
  try {
    const res = db
      .prepare('INSERT INTO entities (parent_id, kind, name, local_code) VALUES (?, ?, ?, ?)')
      .run(input.parentId ?? null, input.kind, input.name, input.localCode);
    return lastId(res);
  } catch (err) {
    rethrowUnique(err, 'duplicate', `entity local code ${input.localCode} already exists`);
  }
}

export function isWithinSubtree(db: DatabaseSync, rootId: number, candidateId: number): boolean {
  const row = db
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM entities WHERE id = ?
         UNION ALL
         SELECT e.id FROM entities e JOIN tree ON e.parent_id = tree.id
       )
       SELECT 1 AS hit FROM tree WHERE id = ?`,
    )
    .get(rootId, candidateId);
  return row !== undefined;
}
