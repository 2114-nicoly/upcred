import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";

const LEGACY_PREFIX = "upcred:draft:";
const PREFIX = "upcred:draft:v2:";
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const FORBIDDEN_KEYS = ["password", "senha", "token", "pwd", "secret"];

/** Remove uma única vez os rascunhos antigos (localStorage, sem "v2"). */
let legacyCleaned = false;
function cleanupLegacyDrafts() {
  if (legacyCleaned) return;
  legacyCleaned = true;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LEGACY_PREFIX) && !k.startsWith(PREFIX)) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

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

function readDraft<T>(k: string): T | null {
  try {
    const raw = sessionStorage.getItem(k);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !parsed || typeof parsed !== "object" ||
      typeof parsed.savedAt !== "number" ||
      Date.now() - parsed.savedAt > MAX_AGE_MS ||
      parsed.data == null
    ) {
      sessionStorage.removeItem(k);
      return null;
    }
    return parsed.data as T;
  } catch {
    try { sessionStorage.removeItem(k); } catch { /* ignore */ }
    return null;
  }
}

type Options = { debounceMs?: number; enabled?: boolean };

/**
 * Rascunho de formulário limitado à AÇÃO atual (usuário + chave + location.key),
 * em sessionStorage, válido por 2h. Só sobrevive quando o navegador oculta/reconstrói
 * a página; ao desmontar por navegação interna, o rascunho é apagado.
 * O listener de visibilidade apenas grava localmente — nunca busca dados nem navega.
 */
export function useFormDraft<T>(key: string, value: T, opts: Options = {}) {
  const { user } = useAuth();
  const location = useLocation();
  const { debounceMs = 500, enabled = true } = opts;
  const fullKey = user?.id ? `${PREFIX}${user.id}:${key}:${location.key}` : null;

  const timerRef = useRef<number | null>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const valueRef = useRef(value);
  valueRef.current = value;
  const fullKeyRef = useRef(fullKey);
  fullKeyRef.current = fullKey;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const pendingRestoreRef = useRef(false);
  const hiddenRef = useRef(false);

  useEffect(() => { cleanupLegacyDrafts(); }, []);

  useEffect(() => {
    if (!fullKey) return;
    const exists = readDraft(fullKey) != null;
    setHasDraft(exists);
    pendingRestoreRef.current = exists;
  }, [fullKey]);

  const writeNow = useCallback(() => {
    const k = fullKeyRef.current;
    if (!k || !enabledRef.current || pendingRestoreRef.current) return;
    try {
      sessionStorage.setItem(k, JSON.stringify({ savedAt: Date.now(), data: sanitize(valueRef.current) }));
    } catch {
      /* ignore */
    }
  }, []);

  // debounce durante a digitação (somente habilitado)
  useEffect(() => {
    if (!fullKey || !enabled) return;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(writeNow, debounceMs);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [fullKey, enabled, value, debounceMs, writeNow]);

  // ocultação/reconstrução pelo navegador: grava imediatamente (somente local)
  useEffect(() => {
    const onPageHide = () => { hiddenRef.current = true; writeNow(); };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") { hiddenRef.current = true; writeNow(); }
      else hiddenRef.current = false;
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [writeNow]);

  // desmonte normal (navegação interna): descarta o rascunho desta ação
  useEffect(() => {
    return () => {
      const k = fullKeyRef.current;
      if (!k || hiddenRef.current) return;
      if (timerRef.current) window.clearTimeout(timerRef.current);
      try { sessionStorage.removeItem(k); } catch { /* ignore */ }
    };
  }, [fullKey]);

  const restore = useCallback((): T | null => {
    if (!fullKey) return null;
    pendingRestoreRef.current = false;
    return readDraft<T>(fullKey);
  }, [fullKey]);

  const clear = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    pendingRestoreRef.current = false;
    setHasDraft(false);
    if (!fullKey) return;
    try { sessionStorage.removeItem(fullKey); } catch { /* ignore */ }
  }, [fullKey]);

  return { hasDraft, restore, clear };
}

/** Limpa todos os rascunhos do usuário (logout): sessionStorage v2 e localStorage antigo. */
export function clearAllDraftsForUser(userId: string | null | undefined) {
  if (!userId) return;
  const purge = (store: Storage, prefix: string) => {
    try {
      const toRemove: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && k.startsWith(prefix)) toRemove.push(k);
      }
      toRemove.forEach((k) => store.removeItem(k));
    } catch {
      /* ignore */
    }
  };
  purge(sessionStorage, `${PREFIX}${userId}:`);
  purge(localStorage, LEGACY_PREFIX);
}
