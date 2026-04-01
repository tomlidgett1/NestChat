import type { ClassifierResult, Capability, DomainTag, ToolNamespace } from './types.ts';

const CAPABILITY_TO_NAMESPACES: Record<Capability, ToolNamespace[]> = {
  'email.read': ['email.read'],
  'email.write': ['email.write'],
  'calendar.read': ['calendar.read'],
  'calendar.write': ['calendar.write'],
  'contacts.read': ['contacts.read'],
  'granola.read': ['granola.read'],
  'web.search': ['web.search'],
  'knowledge.search': ['knowledge.search'],
  'memory.read': ['memory.read'],
  'memory.write': ['memory.write'],
  'travel.search': ['travel.search', 'memory.read', 'knowledge.search'],
  'weather.search': ['weather.search'],
  'reminders.manage': ['reminders.manage'],
  'notifications.watch': ['notifications.watch'],
  'deep_profile': ['memory.read', 'memory.write', 'knowledge.search', 'granola.read', 'email.read', 'calendar.read', 'contacts.read'],
};

const DOMAIN_BASE_TOOLS: Record<DomainTag, ToolNamespace[]> = {
  email: ['email.read', 'email.write', 'contacts.read', 'memory.read', 'notifications.watch'],
  calendar: ['calendar.read', 'calendar.write', 'contacts.read', 'memory.read', 'email.read', 'knowledge.search', 'reminders.manage', 'notifications.watch'],
  meeting_prep: ['calendar.read', 'granola.read', 'email.read', 'contacts.read', 'knowledge.search', 'memory.read', 'web.search'],
  research: ['web.search', 'knowledge.search', 'contacts.read', 'memory.read', 'travel.search', 'weather.search'],
  recall: ['memory.read', 'knowledge.search', 'granola.read', 'calendar.read'],
  contacts: ['contacts.read', 'memory.read'],
  general: [
    'memory.read', 'memory.write', 'email.read', 'email.write',
    'calendar.read', 'calendar.write', 'contacts.read', 'granola.read',
    'web.search', 'knowledge.search', 'travel.search', 'weather.search', 'reminders.manage', 'notifications.watch',
  ],
};

const WRITE_CAPABILITIES: Set<string> = new Set(['email.write', 'calendar.write', 'memory.write', 'reminders.manage', 'notifications.watch']);
const COMPOUND_EXTRAS: ToolNamespace[] = ['contacts.read', 'memory.read'];

const ALWAYS_INCLUDED: ToolNamespace[] = ['messaging.react'];

export function resolveTools(result: ClassifierResult): ToolNamespace[] {
  const nsSet = new Set<ToolNamespace>(ALWAYS_INCLUDED);

  for (const cap of result.requiredCapabilities) {
    const namespaces = CAPABILITY_TO_NAMESPACES[cap];
    if (namespaces) {
      for (const ns of namespaces) nsSet.add(ns);
    }
  }

  if (result.preferredCapabilities) {
    for (const cap of result.preferredCapabilities) {
      const namespaces = CAPABILITY_TO_NAMESPACES[cap];
      if (namespaces) {
        for (const ns of namespaces) nsSet.add(ns);
      }
    }
  }

  if (result.primaryDomain === 'meeting_prep' || result.primaryDomain === 'recall') {
    const baseDomain = DOMAIN_BASE_TOOLS[result.primaryDomain];
    for (const ns of baseDomain) nsSet.add(ns);
  } else if (result.confidence < 0.7) {
    const baseDomain = DOMAIN_BASE_TOOLS[result.primaryDomain];
    if (baseDomain) {
      for (const ns of baseDomain) nsSet.add(ns);
    }
  }

  const hasWrite = result.requiredCapabilities.some(c => WRITE_CAPABILITIES.has(c));
  if (hasWrite) {
    for (const ns of COMPOUND_EXTRAS) nsSet.add(ns);
  }

  if (result.primaryDomain === 'general') {
    const allGeneral = DOMAIN_BASE_TOOLS.general;
    for (const ns of allGeneral) nsSet.add(ns);
  }

  if (result.requiresToolUse && nsSet.size <= ALWAYS_INCLUDED.length) {
    const baseDomain = DOMAIN_BASE_TOOLS[result.primaryDomain];
    if (baseDomain) {
      for (const ns of baseDomain) nsSet.add(ns);
    }
  }

  return [...nsSet];
}

export function resolveToolChoice(result: ClassifierResult): string | undefined {
  if (result.requiresToolUse) return 'required';
  return undefined;
}

export function getBaseToolsForDomain(domain: DomainTag): ToolNamespace[] {
  return [...(DOMAIN_BASE_TOOLS[domain] ?? DOMAIN_BASE_TOOLS.general), ...ALWAYS_INCLUDED];
}

export function expandCapabilities(result: ClassifierResult, _agentFeedback: string): ClassifierResult {
  const expandedCaps = new Set<Capability>(result.requiredCapabilities);

  const baseDomain = DOMAIN_BASE_TOOLS[result.primaryDomain];
  if (baseDomain) {
    for (const ns of baseDomain) {
      const cap = namespaceToCap(ns);
      if (cap) expandedCaps.add(cap);
    }
  }

  if (result.secondaryDomains) {
    for (const domain of result.secondaryDomains) {
      const secondaryBase = DOMAIN_BASE_TOOLS[domain];
      if (secondaryBase) {
        for (const ns of secondaryBase) {
          const cap = namespaceToCap(ns);
          if (cap) expandedCaps.add(cap);
        }
      }
    }
  }

  console.log(`[capability-tools] expanded capabilities: [${[...expandedCaps].join(', ')}] (was: [${result.requiredCapabilities.join(', ')}])`);

  return {
    ...result,
    requiredCapabilities: [...expandedCaps],
    confidence: 1.0,
  };
}

function namespaceToCap(ns: ToolNamespace): Capability | null {
  const map: Partial<Record<ToolNamespace, Capability>> = {
    'email.read': 'email.read',
    'email.write': 'email.write',
    'calendar.read': 'calendar.read',
    'calendar.write': 'calendar.write',
    'contacts.read': 'contacts.read',
    'granola.read': 'granola.read',
    'web.search': 'web.search',
    'knowledge.search': 'knowledge.search',
    'memory.read': 'memory.read',
    'memory.write': 'memory.write',
    'travel.search': 'travel.search',
    'weather.search': 'weather.search',
    'reminders.manage': 'reminders.manage',
    'notifications.watch': 'notifications.watch',
  };
  return map[ns] ?? null;
}

export function hasDeepProfile(result: ClassifierResult): boolean {
  return result.requiredCapabilities.includes('deep_profile');
}
