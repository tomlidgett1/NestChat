export function getInternalEdgeSharedSecret(): string {
  return (
    process.env.INTERNAL_EDGE_SHARED_SECRET ||
    process.env.NEST_INTERNAL_EDGE_SHARED_SECRET ||
    ''
  )
}

export function internalEdgeJsonHeaders(): Record<string, string> {
  const secret = getInternalEdgeSharedSecret()
  if (!secret) {
    throw new Error('INTERNAL_EDGE_SHARED_SECRET is not configured')
  }

  return {
    'Content-Type': 'application/json',
    'x-internal-secret': secret,
  }
}
