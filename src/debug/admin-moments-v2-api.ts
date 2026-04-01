/**
 * Same contract as website/api/admin-moments-v2 (Vercel). Mounted on Nest so Vite can proxy
 * `/api` to localhost:3000 and Moment V2 admin loads locally.
 */
import type { Request, Response as ExpressResponse } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { internalEdgeJsonHeaders } from '../lib/internal-edge-auth.js';

const BILL_REMINDER_AI_PROMPT =
  'Match emails that are bills, invoices, or statements where the user must pay an amount by a date, including upcoming payments, due soon reminders, scheduled upcoming charges, auto-pay notices, and emails saying the bill is overdue or past due. Include utilities, insurance, telco, subscriptions, rates, rent, loans, and credit cards. Do not match generic marketing or newsletters unless they clearly state a payment amount or due date.'

/** Mirrors `moment-v2-catalog` types (website Automations sheet). */
const AUTOMATION_DEFS: Record<
  string,
  { alwaysOn: boolean; frequency: 'daily' | 'weekly' | 'always'; defaultTime: string; defaultDay?: string }
> = {
  email_summary: { alwaysOn: false, frequency: 'daily', defaultTime: '08:00' },
  follow_up_nudge: { alwaysOn: false, frequency: 'daily', defaultTime: '14:00' },
  email_monitor: { alwaysOn: true, frequency: 'always', defaultTime: '09:00' },
  bill_reminders: { alwaysOn: true, frequency: 'always', defaultTime: '08:00' },
  meeting_intel: { alwaysOn: false, frequency: 'daily', defaultTime: '20:00' },
  calendar_heads_up: { alwaysOn: true, frequency: 'always', defaultTime: '09:00' },
  morning_briefing: { alwaysOn: false, frequency: 'daily', defaultTime: '07:30' },
  daily_wrap: { alwaysOn: false, frequency: 'daily', defaultTime: '18:00' },
  weekly_digest: { alwaysOn: false, frequency: 'weekly', defaultTime: '19:00', defaultDay: 'Sunday' },
  relationship_radar: { alwaysOn: false, frequency: 'weekly', defaultTime: '18:00', defaultDay: 'Sunday' },
  news_briefing: { alwaysOn: false, frequency: 'daily', defaultTime: '07:00' },
  market_snapshot: { alwaysOn: false, frequency: 'daily', defaultTime: '07:30' },
}

const ALLOWED_TYPES = new Set(Object.keys(AUTOMATION_DEFS))

function pickEnv(names: string[]): string | undefined {
  for (const name of names) {
    const v = process.env[name]
    if (typeof v === 'string' && v.trim().length > 0) return v.trim()
  }
  return undefined
}

function getNestSupabase(): SupabaseClient | null {
  const url = pickEnv(['NEST_SUPABASE_URL', 'VITE_NEST_SUPABASE_URL', 'SUPABASE_URL'])
  const key = pickEnv([
    'NEST_SUPABASE_SECRET_KEY',
    'SUPABASE_SECRET_KEY',
    'NEW_SUPABASE_SECRET_KEY',
  ])
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

function queryParam(req: Request, key: string): string {
  const v = req.query[key]
  if (typeof v === 'string') return v.trim()
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0].trim()
  return ''
}

function getMainSupabase(): SupabaseClient | null {
  const url = pickEnv(['SUPABASE_URL', 'VITE_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'])
  const key = pickEnv([
    'SUPABASE_SECRET_KEY',
    'NEW_SUPABASE_SECRET_KEY',
  ])
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

function mergeEmailsByField<T extends Record<string, unknown>>(
  a: T[] | null | undefined,
  b: T[] | null | undefined,
  field: keyof T,
): string[] {
  const out = new Set<string>()
  for (const row of [...(a ?? []), ...(b ?? [])]) {
    const e = row[field]
    if (typeof e === 'string' && e.trim()) out.add(e.trim().toLowerCase())
  }
  return [...out]
}

function parseTimeParts(timeStr: string): { hour24: number; minute: number } {
  const [h, m] = timeStr.split(':').map((x) => parseInt(x, 10))
  return { hour24: Number.isFinite(h) ? h : 0, minute: Number.isFinite(m) ? m : 0 }
}

function computeNextRunUtc(params: {
  tz: string
  hour24: number
  minute: number
  weeklyDay?: string
}): Date {
  const { tz, hour24, minute, weeklyDay } = params
  const now = new Date()
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const p = formatter.formatToParts(now)
  const get = (t: string) => parseInt(p.find((x) => x.type === t)?.value ?? '0', 10)
  const tzYear = get('year')
  const tzMonth = get('month')
  const tzDay = get('day')
  const tzHour = get('hour')
  const tzMin = get('minute')
  const tzSec = get('second')
  const tzNowAsUtc = Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, tzMin, tzSec)
  const offsetMs = tzNowAsUtc - now.getTime()
  const targetAsUtc = Date.UTC(tzYear, tzMonth - 1, tzDay, hour24, minute, 0)
  let nextRunUtc = new Date(targetAsUtc - offsetMs)
  if (nextRunUtc.getTime() <= now.getTime()) nextRunUtc = new Date(nextRunUtc.getTime() + 86400000)
  if (weeklyDay) {
    const dayMap: Record<string, number> = {
      Sunday: 0,
      Monday: 1,
      Tuesday: 2,
      Wednesday: 3,
      Thursday: 4,
      Friday: 5,
      Saturday: 6,
    }
    const targetDow = dayMap[weeklyDay] ?? 0
    const currentDow = nextRunUtc.getUTCDay()
    if (currentDow !== targetDow) {
      let daysAhead = targetDow - currentDow
      if (daysAhead <= 0) daysAhead += 7
      nextRunUtc = new Date(nextRunUtc.getTime() + daysAhead * 86400000)
    }
  }
  return nextRunUtc
}

async function ensureBillReminderWebhooks(
  nestUrl: string,
  main: SupabaseClient,
  nest: SupabaseClient,
  handle: string,
  userId: string,
): Promise<void> {
  const base = nestUrl.replace(/\/$/, '')
  const url = `${base}/functions/v1/manage-email-webhooks`
  const headers = internalEdgeJsonHeaders()

  const [{ data: gMain }, { data: gNest }, { data: mMain }, { data: mNest }] = await Promise.all([
    main.from('user_google_accounts').select('google_email').eq('user_id', userId),
    nest.from('user_google_accounts').select('google_email').eq('user_id', userId),
    main.from('user_microsoft_accounts').select('microsoft_email').eq('user_id', userId),
    nest.from('user_microsoft_accounts').select('microsoft_email').eq('user_id', userId),
  ])

  const googleEmails = mergeEmailsByField(gMain ?? [], gNest ?? [], 'google_email')
  const msEmails = mergeEmailsByField(mMain ?? [], mNest ?? [], 'microsoft_email')

  if (googleEmails.length === 0 && msEmails.length === 0) {
    console.warn('[admin-moments-v2] Bill reminders: no linked Google or Microsoft accounts; webhooks not ensured')
    return
  }

  const tasks: Promise<globalThis.Response>[] = []
  for (const email of googleEmails) {
    tasks.push(
      fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'ensure',
          provider: 'google',
          handle,
          account_email: email,
          user_id: userId,
          resource_type: 'email',
        }),
      }),
    )
  }
  for (const email of msEmails) {
    tasks.push(
      fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'ensure',
          provider: 'microsoft',
          handle,
          account_email: email,
          user_id: userId,
          resource_type: 'email',
        }),
      }),
    )
  }
  const settled = await Promise.allSettled(tasks)
  const failed = settled.filter((s) => s.status === 'rejected' || (s.status === 'fulfilled' && !s.value.ok))
  if (failed.length > 0) {
    console.warn(`[admin-moments-v2] manage-email-webhooks: ${failed.length}/${tasks.length} failed`)
  }
}

/** Primary Google, then primary Microsoft, then any linked account email. */
async function fetchPrimaryEmailsForUsers(nest: SupabaseClient, userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (userIds.length === 0) return out
  const chunk = 150
  for (let i = 0; i < userIds.length; i += chunk) {
    const slice = userIds.slice(i, i + chunk)
    const [{ data: gRows }, { data: mRows }] = await Promise.all([
      nest.from('user_google_accounts').select('user_id, google_email, is_primary').in('user_id', slice),
      nest.from('user_microsoft_accounts').select('user_id, microsoft_email, is_primary').in('user_id', slice),
    ])
    type G = { user_id: string; google_email: string | null; is_primary: boolean }
    type M = { user_id: string; microsoft_email: string | null; is_primary: boolean }
    const byUser = new Map<string, { google: G[]; ms: M[] }>()
    for (const uid of slice) byUser.set(uid, { google: [], ms: [] })
    for (const r of (gRows ?? []) as G[]) {
      const b = byUser.get(r.user_id)
      if (b) b.google.push(r)
    }
    for (const r of (mRows ?? []) as M[]) {
      const b = byUser.get(r.user_id)
      if (b) b.ms.push(r)
    }
    for (const uid of slice) {
      const b = byUser.get(uid)!
      const gPrimary = b.google.find((x) => x.is_primary && x.google_email)
      const mPrimary = b.ms.find((x) => x.is_primary && x.microsoft_email)
      const gAny = b.google.find((x) => x.google_email)
      const mAny = b.ms.find((x) => x.microsoft_email)
      const email =
        gPrimary?.google_email?.trim() ||
        mPrimary?.microsoft_email?.trim() ||
        gAny?.google_email?.trim() ||
        mAny?.microsoft_email?.trim() ||
        null
      if (email) out.set(uid, email)
    }
  }
  return out
}

async function fetchProfilesChunked(
  nest: SupabaseClient,
  userIds: string[],
): Promise<
  Array<{ auth_user_id: string; handle: string | null; name: string | null; timezone: string | null }>
> {
  const chunk = 120
  const out: Array<{ auth_user_id: string; handle: string | null; name: string | null; timezone: string | null }> = []
  for (let i = 0; i < userIds.length; i += chunk) {
    const slice = userIds.slice(i, i + chunk)
    const { data, error } = await nest
      .from('user_profiles')
      .select('auth_user_id, handle, name, timezone')
      .in('auth_user_id', slice)
    if (error) throw new Error(error.message)
    if (data) out.push(...(data as typeof out))
  }
  return out
}

export async function handleAdminMomentsV2(req: Request, res: ExpressResponse): Promise<void> {
  const nest = getNestSupabase()
  const main = getMainSupabase()
  if (!nest) {
    res
      .status(503)
      .json({
        error:
          'Nest Supabase not configured (set SUPABASE_URL + SUPABASE_SECRET_KEY, or NEST_SUPABASE_URL + NEST_SUPABASE_SECRET_KEY)',
      })
    return
  }

  const nestUrl =
    pickEnv(['NEST_SUPABASE_URL', 'VITE_NEST_SUPABASE_URL', 'SUPABASE_URL']) ?? ''
  try {
    if (req.method === 'GET') {
      const q = queryParam(req, 'q')
      const userIdSingle = queryParam(req, 'user_id')

      if (userIdSingle) {
        const { data: profile, error: pe } = await nest
          .from('user_profiles')
          .select('auth_user_id, handle, name, timezone')
          .eq('auth_user_id', userIdSingle)
          .maybeSingle()
        if (pe) {
          res.status(400).json({ error: pe.message })
          return
        }
        const { data: automations, error: ae } = await nest
          .from('user_automations')
          .select('id, user_id, automation_type, active, config, next_run_at, last_run_at, updated_at')
          .eq('user_id', userIdSingle)
        if (ae) {
          res.status(400).json({ error: ae.message })
          return
        }
        res.status(200).json({ profile: profile ?? null, automations: automations ?? [] })
        return
      }

      if (q.length >= 1) {
        const { data: profiles, error } = await nest
          .from('user_profiles')
          .select('auth_user_id, handle, name, timezone')
          .or(`handle.ilike.%${q}%,name.ilike.%${q}%`)
          .limit(30)
        if (error) {
          res.status(400).json({ error: error.message })
          return
        }
        res.status(200).json({ profiles: profiles ?? [] })
        return
      }

      if (queryParam(req, 'list_users') === '1') {
        const { data: rows, error } = await nest
          .from('user_profiles')
          .select('auth_user_id, handle, name, timezone')
          .order('name', { ascending: true, nullsFirst: false })
          .order('handle', { ascending: true })
          .limit(8000)
        if (error) {
          res.status(400).json({ error: error.message })
          return
        }
        const ids = (rows ?? []).map((r) => r.auth_user_id as string)
        const emails = await fetchPrimaryEmailsForUsers(nest, ids)
        const users = (rows ?? []).map((r) => {
          const auth_user_id = r.auth_user_id as string
          return {
            auth_user_id,
            handle: r.handle as string | null,
            name: r.name as string | null,
            timezone: r.timezone as string | null,
            email: emails.get(auth_user_id) ?? null,
          }
        })
        res.status(200).json({ users })
        return
      }

      const { data: automations, error } = await nest
        .from('user_automations')
        .select('id, user_id, automation_type, active, config, next_run_at, last_run_at, updated_at')
        .order('updated_at', { ascending: false })
        .limit(8000)

      if (error) {
        res.status(400).json({ error: error.message })
        return
      }

      const userIds = [...new Set((automations ?? []).map((a) => a.user_id as string))]
      const profiles = await fetchProfilesChunked(nest, userIds)

      res.status(200).json({
        automations: automations ?? [],
        profiles,
      })
      return
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body as string) : req.body
      const action = body?.action as string | undefined
      if (action !== 'upsert') {
        res.status(400).json({ error: 'Expected action: upsert' })
        return
      }

      const userId = String(body?.user_id ?? '').trim()
      const automationType = String(body?.automation_type ?? '').trim()
      const active = Boolean(body?.active)
      const configOverride = body?.config as Record<string, unknown> | undefined

      if (!userId || !ALLOWED_TYPES.has(automationType)) {
        res.status(400).json({ error: 'Invalid user_id or automation_type' })
        return
      }

      const { data: profile, error: pErr } = await nest
        .from('user_profiles')
        .select('auth_user_id, handle, name, timezone')
        .eq('auth_user_id', userId)
        .maybeSingle()
      if (pErr) {
        res.status(400).json({ error: pErr.message })
        return
      }
      if (!profile?.auth_user_id) {
        res.status(404).json({ error: 'User profile not found on Nest' })
        return
      }

      const handle = typeof profile.handle === 'string' ? profile.handle : null
      const tz =
        (typeof profile.timezone === 'string' && profile.timezone.trim()
          ? profile.timezone.trim()
          : null) || 'Australia/Sydney'

      const { data: existing } = await nest
        .from('user_automations')
        .select('id, config')
        .eq('user_id', userId)
        .eq('automation_type', automationType)
        .maybeSingle()

      const def = AUTOMATION_DEFS[automationType]

      if (automationType === 'bill_reminders') {
        if (!handle) {
          res.status(400).json({ error: 'User has no Nest handle; cannot enable bill reminders' })
          return
        }
        if (!active) {
          const tid = (existing?.config as { bill_trigger_id?: number } | null)?.bill_trigger_id
          if (typeof tid === 'number') {
            await nest.rpc('delete_notification_watch_trigger', { p_id: tid, p_handle: handle })
          }
          if (existing?.id) {
            await nest
              .from('user_automations')
              .update({
                active: false,
                next_run_at: null,
                config: { timezone: tz },
                updated_at: new Date().toISOString(),
              })
              .eq('id', existing.id)
          }
          res.status(200).json({ ok: true })
          return
        }

        const staleTid = (existing?.config as { bill_trigger_id?: number } | null)?.bill_trigger_id
        if (typeof staleTid === 'number') {
          await nest.rpc('delete_notification_watch_trigger', { p_id: staleTid, p_handle: handle })
        }

        const { data: triggerIdRaw, error: trigErr } = await nest.rpc('insert_notification_watch_trigger', {
          p_handle: handle,
          p_name: 'Bill reminders',
          p_description: 'Bill payment due or overdue notices from email',
          p_trigger_type: 'bill_reminder',
          p_source_type: 'email',
          p_account_email: null,
          p_provider: null,
          p_match_sender: null,
          p_match_subject_pattern: null,
          p_match_labels: null,
          p_use_ai_matching: true,
          p_ai_prompt: BILL_REMINDER_AI_PROMPT,
          p_delivery_method: 'message',
          p_time_constraint: null,
        })

        if (trigErr || triggerIdRaw == null) {
          res.status(400).json({ error: trigErr?.message ?? 'insert_notification_watch_trigger failed' })
          return
        }

        const billTriggerId = typeof triggerIdRaw === 'number' ? triggerIdRaw : Number(triggerIdRaw)
        const config: Record<string, unknown> = { timezone: tz, bill_trigger_id: billTriggerId }

        if (existing?.id) {
          await nest
            .from('user_automations')
            .update({
              active: true,
              next_run_at: null,
              config,
              updated_at: new Date().toISOString(),
            })
            .eq('id', existing.id)
        } else {
          await nest.from('user_automations').insert({
            user_id: userId,
            automation_type: 'bill_reminders',
            active: true,
            config,
            next_run_at: null,
          })
        }

        if (main) {
          await ensureBillReminderWebhooks(nestUrl, main, nest, handle, userId)
        } else {
          await ensureBillReminderWebhooks(nestUrl, nest, nest, handle, userId)
        }

        res.status(200).json({ ok: true })
        return
      }

      if (!active) {
        if (!existing?.id) {
          res.status(200).json({ ok: true })
          return
        }
        await nest
          .from('user_automations')
          .update({
            active: false,
            next_run_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id)
        res.status(200).json({ ok: true })
        return
      }

      const mergedConfig =
        configOverride && typeof configOverride === 'object'
          ? { ...configOverride }
          : ({} as Record<string, unknown>)

      let config: Record<string, unknown> = mergedConfig

      if (def.alwaysOn) {
        config = { timezone: tz, ...mergedConfig }
        const nextRun = new Date(Date.now() + 60000).toISOString()
        if (existing?.id) {
          await nest
            .from('user_automations')
            .update({
              active: true,
              config,
              next_run_at: nextRun,
              updated_at: new Date().toISOString(),
            })
            .eq('id', existing.id)
        } else {
          await nest.from('user_automations').insert({
            user_id: userId,
            automation_type: automationType,
            active: true,
            config,
            next_run_at: nextRun,
          })
        }
        res.status(200).json({ ok: true })
        return
      }

      const timeStr =
        (typeof mergedConfig.time === 'string' && mergedConfig.time.includes(':')
          ? mergedConfig.time
          : def.defaultTime) || '08:00'
      const dayStr =
        def.frequency === 'weekly'
          ? (typeof mergedConfig.day === 'string' ? mergedConfig.day : def.defaultDay) || 'Sunday'
          : undefined

      const { hour24, minute } = parseTimeParts(timeStr)
      const nextRunUtc = computeNextRunUtc({ tz, hour24, minute, weeklyDay: dayStr })

      config = {
        ...mergedConfig,
        time: timeStr,
        timezone: tz,
        ...(def.frequency === 'weekly' && dayStr ? { day: dayStr } : {}),
      }

      if (existing?.id) {
        await nest
          .from('user_automations')
          .update({
            active: true,
            config,
            next_run_at: nextRunUtc.toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id)
      } else {
        await nest.from('user_automations').insert({
          user_id: userId,
          automation_type: automationType,
          active: true,
          config,
          next_run_at: nextRunUtc.toISOString(),
        })
      }

      res.status(200).json({ ok: true })
      return
    }

    res.setHeader('Allow', 'GET, POST')
    res.status(405).json({ error: 'Method not allowed' })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error'
    console.error('[admin-moments-v2]', msg)
    res.status(500).json({ error: msg })
  }
}
