export interface NativeToolLike {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ProposedInternalTool {
  name: string;
  untrustedDescription: string;
  origin: string;
  effect: 'unknown';
  requiresIntegrationReview: true;
  sourceVersion: string;
}

export function translateNativeDescriptor(
  descriptor: NativeToolLike,
  browserVerifiedOrigin: string,
  sourceVersion: string
): ProposedInternalTool {
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,79}$/u.test(descriptor.name)) throw new Error('Invalid native tool name.');
  const origin = new URL(browserVerifiedOrigin).origin;
  return {
    name: descriptor.name,
    untrustedDescription: (descriptor.description ?? '').slice(0, 1_000),
    origin,
    effect: 'unknown',
    requiresIntegrationReview: true,
    sourceVersion
  };
}

// Native exposure is discovery only. This translation never creates a grant,
// approval, trusted effect label, or executable implementation.

