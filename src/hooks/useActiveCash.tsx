import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useEffectiveScope } from "@/hooks/useEffectiveScope";
import { ActiveCash, fetchActiveCash } from "@/lib/active-cash";
import { getTodayCashDate } from "@/lib/cash-lock";

/**
 * Fonte compartilhada do caixa aberto do escopo atual
 * (worker_id + admin_id resolvidos pelo escopo efetivo).
 * Reconsulta sempre que a empresa ou o trabalhador selecionado mudar.
 */
export function useActiveCash() {
  const { effectiveWorkerId, effectiveAdminId } = useEffectiveScope();
  const [activeCash, setActiveCash] = useState<ActiveCash | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const cash = await fetchActiveCash({
        workerId: effectiveWorkerId,
        adminId: effectiveAdminId,
      });
      setActiveCash(cash);
      setError(null);
    } catch (err: any) {
      setActiveCash(null);
      setError(err?.message ?? "Erro ao consultar o caixa aberto");
    } finally {
      setLoading(false);
    }
  }, [effectiveWorkerId, effectiveAdminId]);

  useEffect(() => { void load(); }, [load]);

  return {
    activeCash,
    activeCashDate: activeCash?.cashDate ?? null,
    loading,
    error,
    refresh: load,
    scope: { workerId: effectiveWorkerId, adminId: effectiveAdminId },
  };
}

/**
 * Data operacional das telas Rota do Dia e Caixa do Dia.
 * - ?date= na URL: consulta histórica, respeita a data;
 * - sem ?date=: aguarda a resolução do caixa ativo e abre a data dele;
 * - sem caixa aberto: data atual de America/Sao_Paulo.
 * Nunca carrega "hoje" antes de resolver o caixa ativo.
 */
export function useOperationalDate() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlDate = searchParams.get("date");
  const { activeCash, activeCashDate, loading, refresh, scope, error } = useActiveCash();
  const [resolvedDate, setResolvedDate] = useState<string | null>(urlDate);
  const lastAuto = useRef<string | null>(null);

  useEffect(() => {
    if (urlDate) { setResolvedDate(urlDate); return; }
    if (loading) return;
    const next = activeCashDate ?? getTodayCashDate();
    if (lastAuto.current !== next) {
      lastAuto.current = next;
      setResolvedDate(next);
    }
  }, [urlDate, loading, activeCashDate]);

  const setDate = useCallback((date: string) => {
    setResolvedDate(date);
    const params = new URLSearchParams(searchParams);
    params.set("date", date);
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  const backToActiveCash = useCallback(() => {
    if (!activeCashDate) return;
    setDate(activeCashDate);
  }, [activeCashDate, setDate]);

  const ready = !!resolvedDate && (!!urlDate || !loading);

  return {
    date: resolvedDate,
    ready,
    setDate,
    activeCash,
    activeCashDate,
    activeCashLoading: loading,
    activeCashError: error,
    refreshActiveCash: refresh,
    backToActiveCash,
    /** Está consultando uma data diferente do caixa aberto. */
    viewingOtherDate: !!activeCashDate && !!resolvedDate && resolvedDate !== activeCashDate,
    scope,
  };
}
