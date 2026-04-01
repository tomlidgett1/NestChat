// Edge function: delete-account
// Permanently deletes all user data from every Nest V3 table,
// logs the deletion to deleted_accounts, then removes the auth.users row.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const adminKey =
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  Deno.env.get("NEW_SUPABASE_SECRET_KEY") ??
  "";

const admin = createClient(supabaseUrl, adminKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonRes(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Helper: delete rows from a table by column match, return count
async function deleteFrom(
  table: string,
  column: string,
  value: string,
): Promise<{ count: number; error: string | null }> {
  const { count, error } = await admin
    .from(table)
    .delete({ count: "exact" })
    .eq(column, value);

  return { count: count ?? 0, error: error?.message ?? null };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonRes({ error: "method_not_allowed" }, 405);
  }

  // ── Auth ──────────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!jwt) {
    return jsonRes(
      { error: "unauthorised", detail: "Missing Authorization header" },
      401,
    );
  }

  const {
    data: { user },
    error: authErr,
  } = await admin.auth.getUser(jwt);
  if (authErr || !user) {
    return jsonRes(
      { error: "unauthorised", detail: "Invalid or expired token" },
      401,
    );
  }

  const uid = user.id;
  const userEmail = user.email ?? "";

  // ── Require email confirmation ────────────────────────────────
  let body: { confirmation?: string } = {};
  try {
    body = await req.json();
  } catch {
    return jsonRes({ error: "invalid_body" }, 400);
  }

  if (
    !body.confirmation ||
    body.confirmation.toLowerCase() !== userEmail.toLowerCase()
  ) {
    return jsonRes(
      {
        error: "confirmation_mismatch",
        detail:
          "You must confirm your email address to delete your account.",
      },
      400,
    );
  }

  console.log(
    `[delete-account] Starting deletion for user ${uid} (${userEmail})`,
  );

  // ── Gather pre-deletion stats for audit ───────────────────────
  const handle = await resolveHandle(uid);
  const connectedAccounts = await gatherConnectedAccounts(uid);
  const accountCreatedAt = user.created_at ?? null;

  // Count documents before deletion
  let totalDocs = 0;
  let totalChunks = 0;
  let totalUploads = 0;

  if (handle) {
    const { count: docCount } = await admin
      .from("search_documents")
      .select("id", { count: "exact", head: true })
      .eq("handle", handle);
    totalDocs = docCount ?? 0;
  }

  const { count: chunkCount } = await admin
    .from("user_document_chunks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", uid);
  totalChunks = chunkCount ?? 0;

  const { count: uploadCount } = await admin
    .from("user_uploads")
    .select("id", { count: "exact", head: true })
    .eq("user_id", uid);
  totalUploads = uploadCount ?? 0;

  // ── Phase 1: Manual cleanup (tables keyed by handle) ──────────
  const cleaned: string[] = [];
  const errors: string[] = [];

  // Tables keyed by handle (no FK cascade from auth.users)
  if (handle) {
    await deleteNotificationWebhookEventsForHandle(handle, errors, cleaned);

    for (const table of HANDLE_COLUMN_TABLES) {
      const result = await deleteFrom(table, "handle", handle);
      if (result.error) {
        console.error(`[delete-account] ${table}: ${result.error}`);
        errors.push(`${table}: ${result.error}`);
      } else {
        cleaned.push(table);
        console.log(
          `[delete-account] Deleted ${result.count} rows from ${table}`,
        );
      }
    }

    // conversation_summaries uses sender_handle, not handle
    {
      const result = await deleteFrom(
        "conversation_summaries",
        "sender_handle",
        handle,
      );
      if (result.error) {
        console.error(
          `[delete-account] conversation_summaries: ${result.error}`,
        );
        errors.push(`conversation_summaries: ${result.error}`);
      } else {
        cleaned.push("conversation_summaries");
        console.log(
          `[delete-account] Deleted ${result.count} rows from conversation_summaries`,
        );
      }
    }

    const chatIds = await getChatIdsForHandle(handle);
    for (const table of CHAT_ID_TABLES) {
      if (chatIds.length > 0) {
        const { error } = await admin
          .from(table)
          .delete()
          .in("chat_id", chatIds);
        if (error) {
          console.error(`[delete-account] ${table}: ${error.message}`);
          errors.push(`${table}: ${error.message}`);
        } else {
          cleaned.push(table);
        }
      } else {
        cleaned.push(table);
      }
    }

    // Turn traces (keyed by sender_handle)
    {
      const result = await deleteFrom(
        "turn_traces",
        "sender_handle",
        handle,
      );
      if (result.error) {
        errors.push(`turn_traces: ${result.error}`);
      } else {
        cleaned.push("turn_traces");
      }
    }

    // Webhook events (keyed by sender_handle)
    {
      const result = await deleteFrom(
        "webhook_events",
        "sender_handle",
        handle,
      );
      if (result.error) {
        errors.push(`webhook_events: ${result.error}`);
      } else {
        cleaned.push("webhook_events");
      }
    }

    // Bug reports may only have sender_handle set (auth_user_id null)
    {
      const result = await deleteFrom(
        "reported_bugs",
        "sender_handle",
        handle,
      );
      if (result.error) {
        errors.push(`reported_bugs(sender_handle): ${result.error}`);
      } else {
        cleaned.push("reported_bugs(sender_handle)");
      }
    }

    // User profiles (keyed by handle as PK)
    {
      const result = await deleteFrom(
        "user_profiles",
        "handle",
        handle,
      );
      if (result.error) {
        errors.push(`user_profiles: ${result.error}`);
      } else {
        cleaned.push("user_profiles");
      }
    }
  }

  // Tables keyed by auth_user_id (no FK cascade)
  {
    const authIdTables = [
      "reported_bugs",
    ];

    for (const table of authIdTables) {
      const result = await deleteFrom(table, "auth_user_id", uid);
      if (result.error) {
        errors.push(`${table}: ${result.error}`);
      } else {
        cleaned.push(table);
      }
    }
  }

  // granola_oauth_state (keyed by user_id)
  {
    const result = await deleteFrom("granola_oauth_state", "user_id", uid);
    if (result.error && !result.error.includes("does not exist")) {
      errors.push(`granola_oauth_state: ${result.error}`);
    } else {
      cleaned.push("granola_oauth_state");
    }
  }

  // ── Phase 2: Log deletion to audit table ──────────────────────
  const displayName = await getDisplayName(uid, handle);

  const { error: auditErr } = await admin
    .from("deleted_accounts")
    .insert({
      auth_user_id: uid,
      email: userEmail,
      handle: handle ?? null,
      display_name: displayName,
      connected_accounts: connectedAccounts,
      deletion_reason: "user_requested",
      tables_cleaned: cleaned,
      errors,
      total_documents_deleted: totalDocs,
      total_chunks_deleted: totalChunks,
      total_uploads_deleted: totalUploads,
      account_created_at: accountCreatedAt,
    });

  if (auditErr) {
    console.error(
      `[delete-account] Failed to log deletion audit:`,
      auditErr.message,
    );
    // Don't block deletion on audit failure
  }

  // ── Phase 3: Delete auth user (cascades to FK tables) ─────────
  // This cascades to: user_google_accounts, user_microsoft_accounts,
  // user_granola_accounts, user_uploads, user_document_chunks
  const { error: deleteUserErr } = await admin.auth.admin.deleteUser(uid);

  if (deleteUserErr) {
    console.error(
      `[delete-account] Failed to delete auth user:`,
      deleteUserErr.message,
    );
    return jsonRes(
      {
        error: "deletion_failed",
        detail: `Manual cleanup succeeded for [${cleaned.join(", ")}] but auth.users deletion failed: ${deleteUserErr.message}`,
        partial: true,
      },
      500,
    );
  }

  console.log(
    `[delete-account] Successfully deleted user ${uid} (${userEmail}) — cleaned ${cleaned.length} tables`,
  );

  return jsonRes(
    {
      success: true,
      deleted_user: uid,
      manually_cleaned: cleaned,
      cascaded:
        "user_google_accounts, user_microsoft_accounts, user_granola_accounts, user_uploads, user_document_chunks via auth.users ON DELETE CASCADE",
      errors: errors.length > 0 ? errors : undefined,
    },
    200,
  );
});

// ── Helpers ─────────────────────────────────────────────────────

async function resolveHandle(uid: string): Promise<string | null> {
  const { data } = await admin
    .from("user_profiles")
    .select("handle")
    .eq("auth_user_id", uid)
    .limit(1)
    .maybeSingle();

  return data?.handle ?? null;
}

async function getChatIdsForHandle(handle: string): Promise<string[]> {
  // Include bare handle as chat_id (legacy / edge cases) and every chat_id seen
  // for this participant, matching debug admin purge behaviour.
  const ids = new Set<string>([handle]);
  const [byParticipant, byChatId] = await Promise.all([
    admin.from("conversation_messages").select("chat_id").eq("handle", handle),
    admin.from("conversation_messages").select("chat_id").eq("chat_id", handle),
  ]);
  for (const row of byParticipant.data ?? []) {
    if (row.chat_id) ids.add(row.chat_id as string);
  }
  for (const row of byChatId.data ?? []) {
    if (row.chat_id) ids.add(row.chat_id as string);
  }
  return [...ids];
}

/** Tables keyed by `handle` (not `chat_id` / `sender_handle`). */
const HANDLE_COLUMN_TABLES = [
  "search_embeddings",
  "search_documents",
  "memory_items",
  "proactive_messages",
  "onboarding_events",
  "experiment_assignments",
  "ingestion_tasks",
  "ingestion_jobs",
  "automation_runs",
  "automation_preferences",
  "reminders",
  "notification_webhook_subscriptions",
  "notification_watch_triggers",
  "group_chat_members",
] as const;

const CHAT_ID_TABLES = [
  "conversations",
  "conversation_messages",
  "outbound_messages",
  "tool_traces",
  "pending_actions",
] as const;

async function deleteNotificationWebhookEventsForHandle(
  handle: string,
  errors: string[],
  cleaned: string[],
): Promise<void> {
  const { data: subs, error: subsErr } = await admin
    .from("notification_webhook_subscriptions")
    .select("id, account_email")
    .eq("handle", handle);

  if (subsErr) {
    errors.push(`notification_webhook_subscriptions(select): ${subsErr.message}`);
    return;
  }
  if (!subs?.length) {
    cleaned.push("notification_webhook_events");
    return;
  }

  const subIds = subs.map((s: { id: string }) => s.id);
  const emails = [
    ...new Set(
      subs
        .map((s: { account_email: string }) => s.account_email)
        .filter(Boolean),
    ),
  ];

  const { error: evErr } = await admin
    .from("notification_webhook_events")
    .delete()
    .in("subscription_id", subIds);
  if (evErr) {
    errors.push(`notification_webhook_events(subscription_id): ${evErr.message}`);
    return;
  }

  if (emails.length > 0) {
    const { error: evEmailErr } = await admin
      .from("notification_webhook_events")
      .delete()
      .in("account_email", emails);
    if (evEmailErr) {
      errors.push(`notification_webhook_events(account_email): ${evEmailErr.message}`);
      return;
    }
  }

  cleaned.push("notification_webhook_events");
}

async function gatherConnectedAccounts(
  uid: string,
): Promise<Array<{ provider: string; email: string }>> {
  const accounts: Array<{ provider: string; email: string }> = [];

  const { data: google } = await admin
    .from("user_google_accounts")
    .select("google_email")
    .eq("user_id", uid);
  for (const g of google ?? []) {
    accounts.push({ provider: "google", email: g.google_email });
  }

  const { data: ms } = await admin
    .from("user_microsoft_accounts")
    .select("microsoft_email")
    .eq("user_id", uid);
  for (const m of ms ?? []) {
    accounts.push({ provider: "microsoft", email: m.microsoft_email });
  }

  const { data: granola } = await admin
    .from("user_granola_accounts")
    .select("granola_email")
    .eq("user_id", uid);
  for (const g of granola ?? []) {
    accounts.push({ provider: "granola", email: g.granola_email });
  }

  return accounts;
}

async function getDisplayName(
  uid: string,
  handle: string | null,
): Promise<string | null> {
  if (handle) {
    const { data } = await admin
      .from("user_profiles")
      .select("name")
      .eq("handle", handle)
      .limit(1)
      .maybeSingle();
    if (data?.name) return data.name;
  }

  // Fallback: check Google accounts
  const { data: google } = await admin
    .from("user_google_accounts")
    .select("google_name")
    .eq("user_id", uid)
    .eq("is_primary", true)
    .limit(1)
    .maybeSingle();

  return google?.google_name ?? null;
}
