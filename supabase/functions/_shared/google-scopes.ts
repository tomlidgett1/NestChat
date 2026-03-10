export const GOOGLE_SCOPES = {
  EMAIL: 'email',
  PROFILE: 'profile',
  CALENDAR: 'https://www.googleapis.com/auth/calendar',
  CALENDAR_EVENTS: 'https://www.googleapis.com/auth/calendar.events',
  GMAIL_MODIFY: 'https://www.googleapis.com/auth/gmail.modify',
  GMAIL_SEND: 'https://www.googleapis.com/auth/gmail.send',
  CONTACTS_READONLY: 'https://www.googleapis.com/auth/contacts.readonly',
  CONTACTS_OTHER_READONLY: 'https://www.googleapis.com/auth/contacts.other.readonly',
  DRIVE_READONLY: 'https://www.googleapis.com/auth/drive.readonly',
} as const;

export type GoogleScopeKey = keyof typeof GOOGLE_SCOPES;
export type GoogleScopeValue = (typeof GOOGLE_SCOPES)[GoogleScopeKey];

export const BASE_SCOPES: string[] = [
  GOOGLE_SCOPES.EMAIL,
  GOOGLE_SCOPES.PROFILE,
  GOOGLE_SCOPES.CALENDAR,
  GOOGLE_SCOPES.CALENDAR_EVENTS,
  GOOGLE_SCOPES.GMAIL_MODIFY,
  GOOGLE_SCOPES.GMAIL_SEND,
  GOOGLE_SCOPES.CONTACTS_READONLY,
  GOOGLE_SCOPES.CONTACTS_OTHER_READONLY,
];

export function hasScope(accountScopes: string[], required: string): boolean {
  return accountScopes.includes(required);
}

export function mergeScopes(existing: string[], incoming: string[]): string[] {
  return Array.from(new Set([...existing, ...incoming]));
}

export function parseScopes(spaceSeparated: string): string[] {
  if (!spaceSeparated) return [];
  return spaceSeparated.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

export async function fetchGrantedScopes(accessToken: string): Promise<string[]> {
  try {
    const resp = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    return parseScopes(data.scope ?? '');
  } catch {
    return [];
  }
}

export function buildIncrementalAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  accountEmail: string;
  additionalScope: string;
  state?: string;
}): string {
  const qs = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: params.additionalScope,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    login_hint: params.accountEmail,
  });
  if (params.state) qs.set('state', params.state);
  return `https://accounts.google.com/o/oauth2/v2/auth?${qs.toString()}`;
}
