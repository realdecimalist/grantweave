export type DomainErrorCode =
  | 'not_found'
  | 'validation'
  | 'duplicate'
  | 'invalid_transition'
  | 'budget_exceeded'
  | 'funding_misaligned';

const STATUS: Record<DomainErrorCode, number> = {
  not_found: 404,
  validation: 400,
  duplicate: 409,
  invalid_transition: 409,
  budget_exceeded: 422,
  funding_misaligned: 422,
};

export class DomainError extends Error {
  readonly status: number;

  constructor(readonly code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.status = STATUS[code];
  }
}

export function rethrowConstraint(err: unknown, code: DomainErrorCode, message: string): never {
  if (err instanceof Error) {
    if (err.message.includes('UNIQUE constraint failed')) throw new DomainError(code, message);
    if (err.message.includes('CHECK constraint failed')) throw new DomainError('validation', err.message);
  }
  throw err;
}

export function assertCents(field: string, value: number, minimum = 1): void {
  if (!Number.isInteger(value) || value < minimum || value > Number.MAX_SAFE_INTEGER) {
    throw new DomainError(
      'validation',
      `${field} must be an integer number of cents >= ${minimum}, got ${value}`,
    );
  }
}
