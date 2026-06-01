import { useEffect, useRef, useState, useCallback } from "react";
import { useAuth } from "@/hooks/useAuth";

const PREFIX = "upcred:draft:";
const FORBIDDEN_KEYS = ["password", "senha", "token", "pwd", "secret"];

function safeKey(userId: string | null | undefined, key: string) {
  if (!userId) return null;
  return `${PREFIX}${userId}:${key}`;
}

/** Remove campos sensíveis recursivamente. */
function sanitize<T>(value: T): T {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v)) as any;
  const out: any = {};
  for (const [k, v] of Object.entries(value as any)) {
    if (FORBIDDEN_KEYS.includes(k.toLowerCase())) continue;
    out[k] = sanitize(v as any);
  }
  return out;
}

type Options = {
  /** debounce em ms (default 500) */
  debounceMs?: number;
  /** desabilita persistência condicionalmente */
  enabled?: boolean;
};

/**
 * Autosave de formulários em localStorage por usuário.
 * Retorna { hasDraft, restore, clear }.
 * - hasDraft: existe rascunho salvo (na montagem)
 * - restore(): retorna o último valor salvo (ou null)
 * - clear(): apaga o rascunho (chamar após submit ok)
 *
 * Uso:
 *   const draft = useFormDraft("new-client", formValue);
 *   useEffect(() => {
 *     const saved = draft.restore();
 *     if (saved) { setFormValue(saved); toast("Rascunho restaurado"); }
 *   }, []);
 *   // ao concluir: draft.clear();
 */
export function useFormDraft<T>(key: string, value: T, opts: Options = {}) {
  const { user } = useAuth();
  const { debounceMs = 500, enabled = true } = opts;
  const fullKey = safeKey(user?.id, key);
  const timerRef = useRef<number | null>(null);
  const [hasDraft, setHasDraft] = useState(false);

  // detecta rascunho na montagem (uma vez por key/user)
  useEffect(() => {
    if (!fullKey) return;
    try {
      setHasDraft(!!localStorage.getItem(fullKey));
    } catch {
      /* ignore */
    }
  }, [fullKey]);

  // salva com debounce
  useEffect(() => {
    if (!fullKey || !enabled) return;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      try {
        localStorage.setItem(fullKey, JSON.stringify(sanitize(value)));
      } catch {
        /* quota / private mode — ignora */
      }
    }, debounceMs);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [fullKey, enabled, value, debounceMs]);

  const restore = useCallback((): T | null => {
    if (!fullKey) return null;
    try {
      const raw = localStorage.getItem(fullKey);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }, [fullKey]);

  const clear = useCallback(() => {
    if (!fullKey) return;
    try {
      localStorage.removeItem(fullKey);
      setHasDraft(false);
    } catch {
      /* ignore */
    }
  }, [fullKey]);

  return { hasDraft, restore, clear };
}

/** Limpa todos os rascunhos do usuário (use no logout). */
export function clearAllDraftsForUser(userId: string | null | undefined) {
  if (!userId) return;
  const prefix = `${PREFIX}${userId}:`;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}
