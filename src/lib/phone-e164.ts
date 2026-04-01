/** AU-focused phone normalisation (aligned with edge `phone-normalise.ts`). */

const ADMIN_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i

/** E.164 mobile or lowercase email (iMessage Apple ID). */
export function normaliseBrandInternalAccessHandle(input: string): string | null {
  let s = input.trim()
  if (!s) return null
  if (s.toLowerCase().startsWith('mailto:')) {
    s = s.slice('mailto:'.length).trim()
  }
  if (s.includes('@')) {
    const t = s.toLowerCase()
    return ADMIN_EMAIL_RE.test(t) ? t : null
  }
  return normaliseToE164(s)
}

export function normaliseToE164(input: string): string | null {
  const s0 = input.trim().replace(/[\s().-]/g, '')
  if (!s0 || s0.includes('@')) return null

  let digits = s0.startsWith('+') ? s0.slice(1).replace(/\D/g, '') : s0.replace(/\D/g, '')
  if (digits.length < 9 || digits.length > 15) return null

  if (digits.startsWith('0')) {
    digits = '61' + digits.slice(1)
  }

  if (digits.startsWith('61') && digits.length >= 11 && digits.length <= 15) {
    return `+${digits}`
  }

  if (digits.length >= 10 && digits.length <= 15) {
    return `+${digits}`
  }

  return null
}

export function normaliseInternalAdminPhoneList(raw: unknown, max = 24): string[] {
  const lines: string[] = []
  if (Array.isArray(raw)) {
    for (const x of raw) lines.push(String(x ?? ''))
  } else if (typeof raw === 'string') {
    for (const part of raw.split(/[\n,;]+/)) lines.push(part)
  } else return []

  const out: string[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    const key = normaliseBrandInternalAccessHandle(line)
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
    if (out.length >= max) break
  }
  return out
}
