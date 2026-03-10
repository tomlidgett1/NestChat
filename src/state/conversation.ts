import { getSupabase } from '../lib/supabase.js';

const CONVERSATIONS_TABLE = process.env.SUPABASE_CONVERSATIONS_TABLE || 'conversations';
const USER_PROFILES_TABLE = process.env.SUPABASE_USER_PROFILES_TABLE || 'user_profiles';

// TTL: 1 hour for conversations
const CONVERSATION_TTL_SECONDS = 60 * 60;

// Message with sender tracking for group chats
export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  handle?: string; // Who sent this message (for user messages in group chats)
}

interface ConversationRecord {
  chat_id: string;
  messages: StoredMessage[];
  last_active: number;
  expires_at: string;
}

function sanitiseMessages(value: unknown): StoredMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is StoredMessage => {
      if (!item || typeof item !== 'object') {
        return false;
      }

      const record = item as Record<string, unknown>;
      const role = record.role;
      const content = record.content;
      const handle = record.handle;

      return (
        (role === 'user' || role === 'assistant') &&
        typeof content === 'string' &&
        (typeof handle === 'undefined' || typeof handle === 'string')
      );
    })
    .map(item => ({
      role: item.role,
      content: item.content,
      ...(item.handle ? { handle: item.handle } : {}),
    }));
}

export async function getConversation(chatId: string): Promise<StoredMessage[]> {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from(CONVERSATIONS_TABLE)
      .select('chat_id, messages, last_active, expires_at')
      .eq('chat_id', chatId)
      .maybeSingle<ConversationRecord>();

    if (error) {
      console.error('[conversation] Error getting conversation:', error);
      return [];
    }

    if (!data) {
      return [];
    }

    if (new Date(data.expires_at).getTime() <= Date.now()) {
      await clearConversation(chatId);
      return [];
    }

    return sanitiseMessages(data.messages);
  } catch (error) {
    console.error('[conversation] Error getting conversation:', error);
    return [];
  }
}

export async function addMessage(chatId: string, role: 'user' | 'assistant', content: string, handle?: string): Promise<void> {
  try {
    const messages = await getConversation(chatId);

    const newMessage: StoredMessage = { role, content };
    if (handle) {
      newMessage.handle = handle;
    }
    messages.push(newMessage);

    const trimmedMessages = messages.slice(-20);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = new Date((now + CONVERSATION_TTL_SECONDS) * 1000).toISOString();
    const supabase = getSupabase();

    const { error } = await supabase
      .from(CONVERSATIONS_TABLE)
      .upsert({
        chat_id: chatId,
        messages: trimmedMessages,
        last_active: now,
        expires_at: expiresAt,
      }, {
        onConflict: 'chat_id',
      });

    if (error) {
      throw error;
    }
  } catch (error) {
    console.error('[conversation] Error adding message:', error);
  }
}

export async function clearConversation(chatId: string): Promise<void> {
  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from(CONVERSATIONS_TABLE)
      .delete()
      .eq('chat_id', chatId);

    if (error) {
      throw error;
    }
  } catch (error) {
    console.error('[conversation] Error clearing conversation:', error);
  }
}

export async function clearAllConversations(): Promise<void> {
  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from(CONVERSATIONS_TABLE)
      .delete()
      .gte('chat_id', '');

    if (error) {
      throw error;
    }
  } catch (error) {
    console.error('[conversation] Error clearing all conversations:', error);
  }
}

// ============================================================================
// User Profiles - persistent facts about people (no TTL, kept forever)
// ============================================================================

export interface UserProfile {
  handle: string;
  name: string | null;
  facts: string[];
  firstSeen: number;
  lastSeen: number;
}

interface UserProfileRow {
  handle: string;
  name: string | null;
  facts: unknown;
  first_seen: number;
  last_seen: number;
}

function sanitiseFacts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((fact): fact is string => typeof fact === 'string');
}

export async function getUserProfile(handle: string): Promise<UserProfile | null> {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from(USER_PROFILES_TABLE)
      .select('handle, name, facts, first_seen, last_seen')
      .eq('handle', handle)
      .maybeSingle<UserProfileRow>();

    if (error) {
      console.error('[conversation] Error getting user profile:', error);
      return null;
    }

    if (!data) return null;

    return {
      handle: data.handle,
      name: data.name || null,
      facts: sanitiseFacts(data.facts),
      firstSeen: data.first_seen,
      lastSeen: data.last_seen,
    };
  } catch (error) {
    console.error('[conversation] Error getting user profile:', error);
    return null;
  }
}

export async function updateUserProfile(
  handle: string,
  updates: { name?: string; facts?: string[] }
): Promise<void> {
  try {
    const existing = await getUserProfile(handle);
    const now = Math.floor(Date.now() / 1000);
    const supabase = getSupabase();

    const profile = {
      handle,
      name: updates.name ?? existing?.name ?? null,
      facts: updates.facts ?? existing?.facts ?? [],
      first_seen: existing?.firstSeen ?? now,
      last_seen: now,
    };

    const { error } = await supabase
      .from(USER_PROFILES_TABLE)
      .upsert(profile, {
        onConflict: 'handle',
      });

    if (error) {
      throw error;
    }

    console.log(`[conversation] Updated profile for ${handle}: name=${profile.name}, facts=${profile.facts.length}`);
  } catch (error) {
    console.error('[conversation] Error updating user profile:', error);
  }
}

export async function addUserFact(handle: string, fact: string): Promise<boolean> {
  try {
    const existing = await getUserProfile(handle);
    const facts = existing?.facts ?? [];

    // Don't add duplicate facts
    if (!facts.includes(fact)) {
      facts.push(fact);
      await updateUserProfile(handle, { facts });
      console.log(`[conversation] Added fact for ${handle}: "${fact}"`);
      return true;
    }
    console.log(`[conversation] Fact for ${handle} already exists, skipping: "${fact}"`);
    return false;
  } catch (error) {
    console.error('[conversation] Error adding user fact:', error);
    return false;
  }
}

export async function setUserName(handle: string, name: string): Promise<boolean> {
  try {
    const existing = await getUserProfile(handle);
    // Skip if name is already the same
    if (existing?.name === name) {
      console.log(`[conversation] Name for ${handle} already "${name}", skipping`);
      return false;
    }
    await updateUserProfile(handle, { name });
    console.log(`[conversation] Set name for ${handle}: "${name}"`);
    return true;
  } catch (error) {
    console.error('[conversation] Error setting user name:', error);
    return false;
  }
}

export async function clearUserProfile(handle: string): Promise<boolean> {
  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from(USER_PROFILES_TABLE)
      .delete()
      .eq('handle', handle);

    if (error) {
      throw error;
    }

    console.log(`[conversation] Cleared profile for ${handle}`);
    return true;
  } catch (error) {
    console.error('[conversation] Error clearing user profile:', error);
    return false;
  }
}
