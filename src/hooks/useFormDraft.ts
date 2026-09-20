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
 * - restore(): retorna o último valor salvo (ou null) e marca o rascunho como restaurado
 * - clear(): apaga o rascunho (chamar após submit ok)
 *
 * Persistência:
 * - debounce durante a digitação;
 * - salvamento IMEDIATO em "pagehide", ao ficar oculto (visibilitychange) e ao
 *   desmontar — apenas grava localmente, sem buscar dados, recarregar ou navegar;
 * - um rascunho existente não é sobrescrito por valores iniciais antes de restore().
 *
 * Uso:
 *   const draft = useFormDraft("new-client", formValue);
 *   useEffect(() => {
 *     const saved = draft.restore();
 *     if (saved) { setFormValue(saved); toast("Rascunho restaurado"); }
 *   }, [draft.restore]);
 *   // ao concluir: draft.clear();
 */
export function useFormDraft<T>(key: string, value: T, opts: Options = {}) {
  const { user } = useAuth();
  const { debounceMs = 500, enabled = true } = opts;
  const fullKey = safeKey(user?.id, key);
  const timerRef = useRef<number | null>(null);
  const [hasDraft, setHasDraft] = useState(false);
  // valor mais recente, usado pelos salvamentos imediatos
  const valueRef = useRef(value);
  valueRef.current = value;
  // refs para uso dentro de listeners/efeitos sem depender de re-render
  const fullKeyRef = useRef(fullKey);
  fullKeyRef.current = fullKey;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  // rascunho existente ainda não restaurado: protege contra sobrescrita pelo valor inicial
  const pendingRestoreRef = useRef(false);

  // detecta rascunho na montagem (uma vez por key/user)
  useEffect(() => {
    if (!fullKey) return;
    try {
      const exists = !!localStorage.getItem(fullKey);
      setHasDraft(exists);
      pendingRestoreRef.current = exists;
    } catch {
      /* ignore */
    }
  }, [fullKey]);

  const writeNow = useCallback(() => {
    const k = fullKeyRef.current;
    if (!k || !enabledRef.current) return;
    if (pendingRestoreRef.current) return; // não sobrescrever rascunho antes da restauração
    try {
      localStorage.setItem(k, JSON.stringify(sanitize(valueRef.current)));
    } catch {
      /* quota / private mode — ignora */
    }
  }, []);

  // salva com debounce durante a digitação
  useEffect(() => {
    if (!fullKey || !enabled) return;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(writeNow, debounceMs);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [fullKey, enabled, value, debounceMs, writeNow]);

  // salvamento imediato ao sair da página ou ir para segundo plano (apenas grava localmente)
  useEffect(() => {
    if (!fullKey || !enabled) return;
    const onPageHide = () => writeNow();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") writeNow();
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      // salvamento imediato ao desmontar o componente
      writeNow();
    };
  }, [fullKey, enabled, writeNow]);

  const restore = useCallback((): T | null => {
    if (!fullKey) return null;
    try {
      const raw = localStorage.getItem(fullKey);
      pendingRestoreRef.current = false;
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }, [fullKey]);

  const clear = useCallback(() => {
    if (!fullKey) return;
    try {
      localStorage.removeItem(fullKey);
      pendingRestoreRef.current = false;
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
