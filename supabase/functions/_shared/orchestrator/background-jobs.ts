export type BackgroundJobType =
  | 'memory_extraction'
  | 'document_ingestion'
  | 'proactive_schedule'
  | 'summary_generation';

export interface BackgroundJob {
  id?: string;
  jobType: BackgroundJobType;
  chatId: string;
  senderHandle: string;
  payload: Record<string, unknown>;
  priority: 'low' | 'normal' | 'high';
  status?: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt?: string;
}

export async function queueBackgroundJob(job: BackgroundJob): Promise<string | null> {
  try {
    const { getAdminClient } = await import('../supabase.ts');
    const supabase = getAdminClient();

    const { data, error } = await supabase
      .from('background_jobs')
      .insert({
        job_type: job.jobType,
        chat_id: job.chatId,
        sender_handle: job.senderHandle,
        payload: job.payload,
        priority: job.priority,
        status: 'pending',
      })
      .select('id')
      .single();

    if (error) {
      console.warn('[background-jobs] queue failed:', error.message);
      return null;
    }

    return data?.id ?? null;
  } catch (err) {
    console.warn('[background-jobs] queue error:', (err as Error).message);
    return null;
  }
}

export async function processNextJob(): Promise<BackgroundJob | null> {
  try {
    const { getAdminClient } = await import('../supabase.ts');
    const supabase = getAdminClient();

    const { data, error } = await supabase
      .from('background_jobs')
      .select('*')
      .eq('status', 'pending')
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;

    await supabase
      .from('background_jobs')
      .update({ status: 'processing' })
      .eq('id', data.id);

    return {
      id: data.id,
      jobType: data.job_type,
      chatId: data.chat_id,
      senderHandle: data.sender_handle,
      payload: data.payload,
      priority: data.priority,
      status: 'processing',
    };
  } catch (err) {
    console.warn('[background-jobs] process error:', (err as Error).message);
    return null;
  }
}

export async function completeJob(jobId: string, status: 'completed' | 'failed'): Promise<void> {
  try {
    const { getAdminClient } = await import('../supabase.ts');
    const supabase = getAdminClient();

    await supabase
      .from('background_jobs')
      .update({ status, completed_at: new Date().toISOString() })
      .eq('id', jobId);
  } catch (err) {
    console.warn('[background-jobs] complete error:', (err as Error).message);
  }
}

export function shouldQueueBackgroundWork(
  userMessage: string,
  toolsUsed: Array<{ tool: string; detail?: string }>,
): BackgroundJobType | null {
  if (toolsUsed.length === 0 && userMessage.length > 100) {
    return 'memory_extraction';
  }

  if (toolsUsed.some(t => t.tool === 'email_read') && userMessage.length > 50) {
    return 'summary_generation';
  }

  return null;
}
