export interface SuggestionInput {
  explicitEvent: 'document-imported' | 'workflow-opened' | 'source-selected';
  currentSchemaFingerprint?: string;
  savedWorkflows: Array<{ id: string; schemaFingerprint: string; dismissed: boolean }>;
}

export function suggestCompatibleWorkflow(input: SuggestionInput): string | null {
  if (!input.currentSchemaFingerprint) return null;
  const match = input.savedWorkflows.find(
    (workflow) => !workflow.dismissed && workflow.schemaFingerprint === input.currentSchemaFingerprint
  );
  return match?.id ?? null;
}

// The caller invokes this only after an explicit event or bounded idle task.
// A suggestion is read-only and carries no approval or execution authority.

