import { supabase } from "@/integrations/supabase/client";

/**
 * Returns the current authenticated user's id, or null if not logged in.
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

let _workerIdCache: { uid: string; workerId: string | null } | null = null;

/**
 * Returns the worker_id for the currently authenticated user, or null if the
 * user is not a worker (admin / super_admin / no row). Cached per session.
 *
 * Used to scope queries explicitly by worker, on top of the RLS that the DB
 * already applies.
 */
export async function getCurrentWorkerId(): Promise<string | null> {
  const uid = await getCurrentUserId();
  if (!uid) { _workerIdCache = null; return null; }
  if (_workerIdCache && _workerIdCache.uid === uid) return _workerIdCache.workerId;
  const { data } = await supabase
    .from("workers")
    .select("id")
    .eq("auth_user_id", uid)
    .maybeSingle();
  const workerId = (data?.id as string | undefined) ?? null;
  _workerIdCache = { uid, workerId };
  return workerId;
}
