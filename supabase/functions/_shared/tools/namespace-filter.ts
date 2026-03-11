import type { ToolNamespace } from '../orchestrator/types.ts';
import type { ToolContract } from './types.ts';
import { getAllTools } from './registry.ts';

export function filterToolsByNamespace(
  allowedNamespaces: ToolNamespace[],
): ToolContract[] {
  const nsSet = new Set<string>(allowedNamespaces);
  return getAllTools().filter((t) => nsSet.has(t.namespace));
}
