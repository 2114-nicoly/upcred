import { useCallback, useEffect, useState } from "react";
import { ActiveCash } from "@/lib/active-cash";
import { CashScope, fetchScopedActiveCash, scopeKey } from "@/lib/loan-cash";

/**
 * Caixa aberto de um escopo EXATO (trabalhador dono do empréstimo/cliente).
 *
 * Ao trocar de empresa, trabalhador ou empréstimo, a data anterior é
 * descartada imediatamente e um novo carregamento é iniciado — nunca fica a
 * data do trabalhador anterior.
 */
export function useScopedActiveCash(scope: CashScope | null) {
  const key = scopeKey(scope);
  const [activeCash, setActiveCash] = useState<ActiveCash | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!key || !scope) {
      setActiveCash(null);
      setError(null);
      setLoading(false);
      return;
    }
    setActiveCash(null);
    setError(null);
    setLoading(true);
    try {
      const cash = await fetchScopedActiveCash(scope);
      setActiveCash(cash);
    } catch (err: any) {
      setActiveCash(null);
      setError(err?.message ?? "Erro ao consultar o caixa do trabalhador");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => { void load(); }, [load]);

  return {
    scope,
    activeCash,
    cashDate: activeCash?.cashDate ?? null,
    loading,
    error,
    /** Escopo resolvido e com caixa aberto — libera os botões de ação. */
    ready: !!key && !loading && !!activeCash,
    refresh: load,
  };
}
