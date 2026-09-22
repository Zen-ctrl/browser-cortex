interface Pair {
  request: string;
  plan: {
    schemaVersion: 1;
    operation: 'rows.filter';
    field: string;
    comparison: 'eq' | 'neq';
    value: string;
  };
}

export function generateVerifiedPair(field: string, value: string, negate = false): Pair {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(field)) throw new Error('Invalid synthetic field.');
  if (!value || value.length > 100) throw new Error('Invalid synthetic value.');
  return {
    request: negate ? `Keep records where ${field} is not ${value}.` : `Keep records where ${field} is ${value}.`,
    plan: {
      schemaVersion: 1,
      operation: 'rows.filter',
      field,
      comparison: negate ? 'neq' : 'eq',
      value
    }
  };
}

// Training or distillation is intentionally not performed in this repository.
// Any future dataset must pass the production workflow validator and document
// upstream model, dataset rights, held-out splits, and contamination checks.

