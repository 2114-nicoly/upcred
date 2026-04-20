import { supabase } from "@/integrations/supabase/client";

/**
 * Returns the current authenticated user's id, or null if not logged in.
 * Cached per session — call this in any insert path to inject user_id.
 */
export async function getCurrentUserId(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
}

/**
 * Returns the current user id or throws — use when an operation MUST be authenticated.
 */
export async function requireUserId(): Promise<string> {
  const id = await getCurrentUserId();
  if (!id) throw new Error("Sessão expirada. Faça login novamente.");
  return id;
}
