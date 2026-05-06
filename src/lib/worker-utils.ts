import { supabase } from "@/integrations/supabase/client";

export const WORKER_EMAIL_DOMAIN = "upcred.local";

/**
 * Returns the worker_id (from public.workers) for the currently authenticated user.
 * Returns null if the user is admin (no worker_id) or has no worker entry.
 */
export async function getCurrentWorkerId(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) return null;
  const { data } = await supabase
    .from("workers")
    .select("id")
    .eq("auth_user_id", session.user.id)
    .maybeSingle();
  return data?.id ?? null;
}

/** 4-digit code, zero-padded */
export function generateLoginCodigo(): string {
  return String(Math.floor(Math.random() * 10000)).padStart(4, "0");
}

/** 8-digit numeric password */
export function generateTempPassword(): string {
  return String(Math.floor(Math.random() * 100000000)).padStart(8, "0");
}

export function syntheticEmailFor(loginCodigo: string): string {
  return `w${loginCodigo}@${WORKER_EMAIL_DOMAIN}`;
}

export function isLoginCodigo(value: string): boolean {
  return /^\d{4}$/.test(value.trim());
}
