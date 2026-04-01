/**
 * Builds an `sms:` URL for the production Nest bot (Messages / iMessage).
 * Uses the first number in LINQ_AGENT_BOT_NUMBERS, or NEST_IMESSAGE_NUMBER as override.
 */
export function getNestImessageSmsHref(): string | null {
  const raw = (process.env.LINQ_AGENT_BOT_NUMBERS || process.env.NEST_IMESSAGE_NUMBER || '')
    .split(',')[0]
    ?.trim()
    .replace(/\s+/g, '');
  if (!raw) return null;

  let e164 = raw.replace(/[^\d+]/g, '');
  if (!e164.startsWith('+')) {
    e164 = '+' + e164.replace(/^0+/, '');
  }
  if (e164.replace(/\D/g, '').length < 8) return null;

  return 'sms:' + e164;
}
