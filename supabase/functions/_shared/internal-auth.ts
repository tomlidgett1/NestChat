import { getOptionalEnv } from './env.ts';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function getInternalEdgeSharedSecret(): string | undefined {
  return (
    getOptionalEnv('INTERNAL_EDGE_SHARED_SECRET') ??
    getOptionalEnv('NEST_INTERNAL_EDGE_SHARED_SECRET')
  );
}

export function readInternalAuthToken(req: Request): string {
  const headerSecret = req.headers.get('x-internal-secret')?.trim();
  if (headerSecret) return headerSecret;

  const authHeader = req.headers.get('Authorization') ?? '';
  return authHeader.replace(/^Bearer\s+/i, '').trim();
}

export function authorizeInternalRequest(req: Request): boolean {
  const expected = getInternalEdgeSharedSecret();
  if (!expected) return false;
  const received = readInternalAuthToken(req);
  if (!received) return false;
  return timingSafeEqual(received, expected);
}

export function internalJsonHeaders(secret = getInternalEdgeSharedSecret() ?? ''): Record<string, string> {
  return {
    'x-internal-secret': secret,
    'Content-Type': 'application/json',
  };
}
