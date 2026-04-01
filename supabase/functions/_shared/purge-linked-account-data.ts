// When a user disconnects Google, Microsoft, or Granola, remove Nest data scoped
// to that linked email: RAG rows, notification watches, and queued ingestion tasks.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type LinkedAccountProvider = "google" | "microsoft" | "granola";

export interface PurgeLinkedAccountParams {
  handle: string;
  provider: LinkedAccountProvider;
  /** Canonical email for the row being removed (google_email / microsoft_email / granola_email). */
  accountEmail: string;
  /** Count of user_granola_accounts rows after this unlink (0 = user has no Granola left). */
  granolaCountAfterRemoval: number;
}

async function getChatIdsForHandle(
  supabase: SupabaseClient,
  handle: string,
): Promise<string[]> {
  const ids = new Set<string>([handle]);
  const [byParticipant, byChatId] = await Promise.all([
    supabase.from("conversation_messages").select("chat_id").eq("handle", handle),
    supabase.from("conversation_messages").select("chat_id").eq("chat_id", handle),
  ]);
  for (const row of byParticipant.data ?? []) {
    if (row.chat_id) ids.add(row.chat_id as string);
  }
  for (const row of byChatId.data ?? []) {
    if (row.chat_id) ids.add(row.chat_id as string);
  }
  return [...ids];
}

async function deleteNotificationWebhookEventsForSubscriptionIds(
  supabase: SupabaseClient,
  subIds: string[],
  accountEmails: string[],
  errors: string[],
): Promise<void> {
  if (subIds.length === 0) return;
  const { error: evErr } = await supabase
    .from("notification_webhook_events")
    .delete()
    .in("subscription_id", subIds);
  if (evErr) {
    errors.push(`notification_webhook_events(subscription_id): ${evErr.message}`);
    return;
  }
  if (accountEmails.length > 0) {
    const { error: evEmailErr } = await supabase
      .from("notification_webhook_events")
      .delete()
      .in("account_email", accountEmails);
    if (evEmailErr) {
      errors.push(`notification_webhook_events(account_email): ${evEmailErr.message}`);
    }
  }
}

/**
 * Removes DB artefacts tied to one connected inbox / Granola identity.
 * Call before deleting the user_google_accounts / user_microsoft_accounts / user_granola_accounts row.
 */
export async function purgeLinkedAccountData(
  supabase: SupabaseClient,
  p: PurgeLinkedAccountParams,
): Promise<{ errors: string[] }> {
  const errors: string[] = [];
  const exact = p.accountEmail.trim();
  const norm = exact.toLowerCase();
  if (!exact) {
    return { errors: ["empty account email"] };
  }

  // ── Notification webhooks (Google / Microsoft only) ────────────
  if (p.provider === "google" || p.provider === "microsoft") {
    let subs: { id: string; account_email: string }[] | null = null;
    const firstSel = await supabase
      .from("notification_webhook_subscriptions")
      .select("id, account_email")
      .eq("handle", p.handle)
      .eq("provider", p.provider)
      .eq("account_email", exact);
    if (firstSel.error) {
      errors.push(`notification_webhook_subscriptions(select): ${firstSel.error.message}`);
    } else {
      subs = firstSel.data;
      if ((!subs || subs.length === 0) && norm !== exact) {
        const secondSel = await supabase
          .from("notification_webhook_subscriptions")
          .select("id, account_email")
          .eq("handle", p.handle)
          .eq("provider", p.provider)
          .eq("account_email", norm);
        if (secondSel.error) {
          errors.push(
            `notification_webhook_subscriptions(select alt): ${secondSel.error.message}`,
          );
        } else {
          subs = secondSel.data;
        }
      }
    }

    if (
      !errors.some((e) => e.startsWith("notification_webhook_subscriptions(select)")) &&
      subs?.length
    ) {
      const subIds = subs.map((s: { id: string }) => s.id);
      const emails = [
        ...new Set(
          subs
            .map((s: { account_email: string }) => s.account_email)
            .filter(Boolean),
        ),
      ];
      await deleteNotificationWebhookEventsForSubscriptionIds(
        supabase,
        subIds,
        emails,
        errors,
      );
      if (!errors.some((e) => e.startsWith("notification_webhook_events"))) {
        const delSub = async (email: string) => {
          const { error: delSubErr } = await supabase
            .from("notification_webhook_subscriptions")
            .delete()
            .eq("handle", p.handle)
            .eq("provider", p.provider)
            .eq("account_email", email);
          if (delSubErr) {
            errors.push(`notification_webhook_subscriptions(delete ${email}): ${delSubErr.message}`);
          }
        };
        await delSub(exact);
        if (norm !== exact) await delSub(norm);
      }
    }
  }

  // ── Notification watch triggers (nullable account = leave as-is) ─
  {
    const delTrigger = async (email: string) => {
      const { error: trigErr } = await supabase
        .from("notification_watch_triggers")
        .delete()
        .eq("handle", p.handle)
        .not("account_email", "is", null)
        .eq("account_email", email);
      if (trigErr) {
        errors.push(`notification_watch_triggers(${email}): ${trigErr.message}`);
      }
    };
    await delTrigger(exact);
    if (norm !== exact) await delTrigger(norm);
  }

  // ── Ingestion tasks still queued for this inbox ───────────────
  {
    const delTasks = async (email: string) => {
      const { error: taskErr } = await supabase
        .from("ingestion_tasks")
        .delete()
        .eq("handle", p.handle)
        .filter("params->>account_email", "eq", email);
      if (taskErr) {
        errors.push(`ingestion_tasks(${email}): ${taskErr.message}`);
      }
    };
    await delTasks(exact);
    if (norm !== exact) await delTasks(norm);
  }

  // ── Draft / pending actions scoped to this account ────────────
  const chatIds = await getChatIdsForHandle(supabase, p.handle);
  if (chatIds.length > 0) {
    const delPending = async (email: string) => {
      const { error: paErr } = await supabase
        .from("pending_actions")
        .delete()
        .in("chat_id", chatIds)
        .eq("account", email);
      if (paErr) {
        errors.push(`pending_actions(${email}): ${paErr.message}`);
      }
    };
    await delPending(exact);
    if (norm !== exact) await delPending(norm);
  }

  // ── RAG: search_documents (embeddings cascade on document delete) ─
  {
    if (p.provider === "granola" && p.granolaCountAfterRemoval === 0) {
      const { error: ragErr } = await supabase
        .from("search_documents")
        .delete()
        .eq("handle", p.handle)
        .like("source_id", "granola:%");
      if (ragErr) {
        errors.push(`search_documents(granola all): ${ragErr.message}`);
      }
    } else if (p.provider === "granola" && p.granolaCountAfterRemoval > 0) {
      const { data: summaries, error: sumErr } = await supabase
        .from("search_documents")
        .select("source_id")
        .eq("handle", p.handle)
        .eq("source_type", "meeting_summary")
        .filter("metadata->>account", "eq", exact);

      if (sumErr) {
        errors.push(`search_documents(select granola summaries): ${sumErr.message}`);
      } else {
        let sourceIds = [
          ...new Set(
            (summaries ?? []).map((r: { source_id: string }) => r.source_id),
          ),
        ];
        if (norm !== exact) {
          const { data: sumNorm } = await supabase
            .from("search_documents")
            .select("source_id")
            .eq("handle", p.handle)
            .eq("source_type", "meeting_summary")
            .filter("metadata->>account", "eq", norm);
          sourceIds = [
            ...new Set([
              ...sourceIds,
              ...(sumNorm ?? []).map((r: { source_id: string }) => r.source_id),
            ]),
          ];
        }
        if (sourceIds.length > 0) {
          const { error: ragErr } = await supabase
            .from("search_documents")
            .delete()
            .eq("handle", p.handle)
            .in("source_id", sourceIds);
          if (ragErr) {
            errors.push(`search_documents(granola by source_id): ${ragErr.message}`);
          }
        }
      }
      const delMeta = async (email: string) => {
        const { error: metaGranolaErr } = await supabase
          .from("search_documents")
          .delete()
          .eq("handle", p.handle)
          .filter("metadata->>account", "eq", email);
        if (metaGranolaErr) {
          errors.push(`search_documents(granola metadata, ${email}): ${metaGranolaErr.message}`);
        }
      };
      await delMeta(exact);
      if (norm !== exact) await delMeta(norm);
    } else {
      const delRagMeta = async (email: string) => {
        const { error: ragErr } = await supabase
          .from("search_documents")
          .delete()
          .eq("handle", p.handle)
          .filter("metadata->>account", "eq", email);
        if (ragErr) {
          errors.push(`search_documents(metadata account, ${email}): ${ragErr.message}`);
        }
      };
      await delRagMeta(exact);
      if (norm !== exact) await delRagMeta(norm);
    }
  }

  if (errors.length > 0) {
    console.error(
      `[purge-linked-account] Partial errors for ${p.provider} ${norm}:`,
      errors.join("; "),
    );
  } else {
    console.log(
      `[purge-linked-account] Cleaned linked data for ${p.provider} ${norm} (handle=${p.handle})`,
    );
  }

  return { errors };
}
