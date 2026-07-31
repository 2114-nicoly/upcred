import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useConfirm } from "@/hooks/useConfirm";
import { useAuth } from "@/hooks/useAuth";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Loader2, ChevronDown, Building2 } from "lucide-react";
import AccessStatusBadge from "@/components/access/AccessStatusBadge";
import WorkerAccessSummary from "@/components/access/WorkerAccessSummary";
import WorkerRequestsSuperAdminSection from "@/components/access/WorkerRequestsSuperAdminSection";
import RenewAccessDialog from "@/components/access/RenewAccessDialog";
import AccessHistoryDialog from "@/components/access/AccessHistoryDialog";
import PauseAccessDialog from "@/components/access/PauseAccessDialog";
import PauseCompanyDialog from "@/components/access/PauseCompanyDialog";


import {
  AccessMaps,
  AccessStatus,
  EMPTY_ACCESS_MAPS,
  daysRemaining,
  ACCESS_STATUS_FILTERS,
  companyStatusLabel,
  isCompanyPaused,
  formatDateTime,
  fetchGrantorNames,
  fetchEnforcementState,
  setEnforcementEnabled,
  formatMoney,
  getAccessStatus,
  getEffectiveAccessStatus,
  loadAccessMaps,
} from "@/lib/access-control";


type AdminRow = { id: string; nome: string };
type WorkerRow = { id: string; nome: string; parent_admin_id: string | null };

/** Aba "Acessos" — visão global, somente leitura nesta etapa. */
export default function AccessManagementTab() {
  const confirm = useConfirm();
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [enforcement, setEnforcement] = useState(false);
  const [enforcementError, setEnforcementError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [workers, setWorkers] = useState<WorkerRow[]>([]);
  const [maps, setMaps] = useState<AccessMaps>(EMPTY_ACCESS_MAPS);
  const [companyFilter, setCompanyFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<AccessStatus | "all">("all");
  const [pauserNames, setPauserNames] = useState<Record<string, string>>({});
  const [paymentRange, setPaymentRange] = useState<"month" | "30d" | "year" | "all">("month");

  const reload = async () => {
    setLoading(true);
    try {
      const [enf, adminsRes, workersRes, m] = await Promise.all([
        fetchEnforcementState(),
        supabase.rpc("super_admin_list_admins" as any),
        supabase.rpc("list_workers_by_admin" as any, { p_admin_id: null, p_include_archived: false }),
        loadAccessMaps(),
      ]);
      setEnforcement(enf.enabled);
      setEnforcementError(enf.error);
      setAdmins(((adminsRes.data as any[]) ?? []).map((a) => ({ id: a.id, nome: a.nome })));
      setWorkers(((workersRes.data as any[]) ?? []).map((w) => ({ id: w.id, nome: w.nome, parent_admin_id: w.parent_admin_id ?? null })));
      setMaps(m);
      setPauserNames(await fetchGrantorNames(Object.values(m.controlByAdmin).map((c) => c.paused_by)));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, []);

  const toggleEnforcement = async () => {
    const next = !enforcement;
    if (next) {
      let paused = 0, expired = 0, scheduled = 0;
      workers.forEach((w) => {
        const s = getAccessStatus(maps.licenseByWorker[w.id]);
        if (s === "paused") paused++;
        else if (s === "expired") expired++;
        else if (s === "scheduled") scheduled++;
      });
      const ok = await confirm({
        title: "Ativar bloqueio de acesso?",
        description:
          "Nenhum usuário ou dado será excluído. Apenas o acesso dos trabalhadores indicados será bloqueado.",
        affected: [
          { label: "Trabalhadores pausados", value: String(paused) },
          { label: "Trabalhadores expirados", value: String(expired) },
          { label: "Acesso ainda não iniciado", value: String(scheduled) },
          { label: "Total que perderá o acesso", value: String(paused + expired + scheduled) },
        ],
        confirmText: "Ativar bloqueio",
        destructive: true,
      });
      if (!ok) return;
    } else {
      const ok = await confirm({
        title: "Desativar bloqueio de acesso?",
        description:
          "O bloqueio será suspenso, mas os status, vencimentos, pausas e históricos continuarão registrados.",
        confirmText: "Desativar bloqueio",
      });
      if (!ok) return;
    }

    setSaving(true);
    try {
      await setEnforcementEnabled(next, user?.id ?? null);
      setEnforcement(next);
      setEnforcementError(false);
      toast.success(next ? "Bloqueio ativado." : "Bloqueio desativado.");
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message ?? "Não foi possível alterar o bloqueio.");
    } finally {
      setSaving(false);
    }
  };



  /** Status exibido com a prioridade oficial (empresa pausada em primeiro). */
  const statusOf = (workerId: string) => {
    const w = workers.find((x) => x.id === workerId);
    const control = w?.parent_admin_id ? maps.controlByAdmin[w.parent_admin_id] : null;
    return getEffectiveAccessStatus(maps.licenseByWorker[workerId], isCompanyPaused(control));
  };

  const visibleWorkers = useMemo(
    () =>
      workers.filter((w) => {
        if (companyFilter !== "all" && w.parent_admin_id !== companyFilter) return false;
        if (statusFilter !== "all" && statusOf(w.id) !== statusFilter) return false;
        return true;
      }),
    [workers, companyFilter, statusFilter, maps],
  );

  const paymentsTotal = useMemo(() => {
    const now = new Date();
    let from: Date | null = null;
    if (paymentRange === "month") from = new Date(now.getFullYear(), now.getMonth(), 1);
    else if (paymentRange === "30d") from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
    else if (paymentRange === "year") from = new Date(now.getFullYear(), 0, 1);

    const scopedIds = new Set(
      workers.filter((w) => companyFilter === "all" || w.parent_admin_id === companyFilter).map((w) => w.id),
    );
    return maps.allPeriods.reduce((acc, p) => {
      if (!scopedIds.has(p.worker_id)) return acc;
      const when = new Date(p.paid_at ?? p.created_at);
      if (from && (isNaN(when.getTime()) || when < from)) return acc;
      return acc + Number(p.amount_paid ?? 0);
    }, 0);
  }, [maps, workers, companyFilter, paymentRange]);

  const totals = useMemo(() => {
    const scoped = workers.filter((w) => companyFilter === "all" || w.parent_admin_id === companyFilter);
    let configured = 0, unconfigured = 0, active = 0, expiringSoon = 0, expired = 0, paused = 0, monthly = 0;
    scoped.forEach((w) => {
      const lic = maps.licenseByWorker[w.id];
      if (lic) { configured++; monthly += Number(lic.monthly_price ?? 0); } else unconfigured++;
      const s = statusOf(w.id);
      if (s === "active" || s === "expiring") active++;
      if (s === "expiring") {
        const d = daysRemaining(lic);
        if (d != null && d >= 0 && d <= 7) expiringSoon++;
      }
      if (s === "expired") expired++;
      if (s === "paused") paused++;
    });
    return {
      companies: companyFilter === "all" ? admins.length : 1,
      workers: scoped.length,
      configured, unconfigured, active, expiringSoon, expired, paused, monthly,
    };
  }, [workers, admins, companyFilter, maps]);

  const companies = useMemo(
    () => admins.filter((a) => companyFilter === "all" || a.id === companyFilter),
    [admins, companyFilter],
  );

  if (loading) {
    return <div className="flex h-48 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }

  return (
    <div className="space-y-3">
      <WorkerRequestsSuperAdminSection onChanged={() => void reload()} />

      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-xs font-medium">Controle automático de acesso</p>
              <p className="text-[10px] text-muted-foreground">
                {enforcementError
                  ? "Não foi possível confirmar o estado do bloqueio."
                  : enforcement
                    ? "Bloqueio ativado — trabalhadores pausados, expirados ou ainda não iniciados não conseguem entrar."
                    : "Bloqueio desativado — nenhum trabalhador é impedido de entrar por mensalidade."}
              </p>
            </div>
            <Badge variant={enforcementError ? "outline" : enforcement ? "destructive" : "secondary"} className="text-[10px] shrink-0">
              {enforcementError ? "Estado desconhecido" : enforcement ? "Bloqueio ativado" : "Bloqueio desativado"}
            </Badge>
          </div>
          <Button
            size="sm"
            variant={enforcement ? "outline" : "default"}
            className="h-8 w-full text-xs"
            disabled={saving || enforcementError}
            onClick={() => void toggleEnforcement()}
          >
            {saving && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
            {enforcement ? "Desativar bloqueio" : "Ativar bloqueio"}
          </Button>
        </CardContent>
      </Card>



      <Card>
        <CardContent className="p-3 grid grid-cols-2 gap-2 text-[11px]">
          <Metric label="Empresas" value={String(totals.companies)} />
          <Metric label="Trabalhadores" value={String(totals.workers)} />
          <Metric label="Licenças configuradas" value={String(totals.configured)} />
          <Metric label="Não configuradas" value={String(totals.unconfigured)} />
          <Metric label="Ativos" value={String(totals.active)} />
          <Metric label="Vencendo em até 7 dias" value={String(totals.expiringSoon)} />
          <Metric label="Expirados" value={String(totals.expired)} />
          <Metric label="Pausados" value={String(totals.paused)} />
          <Metric label="Valor mensal configurado" value={formatMoney(totals.monthly)} />
          <Metric label="Pagamentos no período" value={formatMoney(paymentsTotal)} />
          <div className="col-span-2">
            <Select value={paymentRange} onValueChange={(v) => setPaymentRange(v as typeof paymentRange)}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="month">Pagamentos: este mês</SelectItem>
                <SelectItem value="30d">Pagamentos: últimos 30 dias</SelectItem>
                <SelectItem value="year">Pagamentos: este ano</SelectItem>
                <SelectItem value="all">Pagamentos: todo o período</SelectItem>
              </SelectContent>
            </Select>
            <p className="mt-1 text-[9px] text-muted-foreground">
              Mensalidades do sistema — não entram no caixa dos trabalhadores nem nos relatórios operacionais.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-2">
        <Select value={companyFilter} onValueChange={(v) => setCompanyFilter(v)}>
          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Empresa" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as empresas</SelectItem>
            {admins.map((a) => <SelectItem key={a.id} value={a.id}>{a.nome}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as AccessStatus | "all")}>
          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Situação" /></SelectTrigger>
          <SelectContent>
            {ACCESS_STATUS_FILTERS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {companies.length === 0 && (
        <Card><CardContent className="p-4 text-center text-sm text-muted-foreground">Nenhuma empresa cadastrada.</CardContent></Card>
      )}

      {companies.map((a) => {
        const list = visibleWorkers.filter((w) => w.parent_admin_id === a.id);
        const all = workers.filter((w) => w.parent_admin_id === a.id);
        const configured = all.filter((w) => maps.licenseByWorker[w.id]);
        const sum = configured.reduce((acc, w) => acc + Number(maps.licenseByWorker[w.id]?.monthly_price ?? 0), 0);
        const control = maps.controlByAdmin[a.id];
        return (
          <Collapsible key={a.id}>
            <Card>
              <CollapsibleTrigger className="w-full text-left">
                <CardContent className="p-3 flex items-start gap-2">
                  <Building2 className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate flex items-center gap-1 flex-wrap">
                      {a.nome}
                      <Badge variant={control?.manual_status === "paused" ? "secondary" : "outline"} className="text-[9px]">
                        {companyStatusLabel(control)}
                      </Badge>
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {all.length} trabalhador(es) · {configured.length} licença(s) configurada(s) · {formatMoney(sum)}/mês
                    </p>
                  </div>
                  <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                </CardContent>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="px-3 pb-3 pt-0 space-y-2">
                  <div className="rounded-md border p-2 text-[10px] space-y-1">
                    <p>
                      Situação da empresa:{" "}
                      <span className="font-medium">{companyStatusLabel(control)}</span>
                    </p>
                    {isCompanyPaused(control) && (
                      <>
                        <p>Motivo: <span className="font-medium">{control?.pause_reason || "—"}</span></p>
                        <p>Pausada em: <span className="font-medium">{formatDateTime(control?.paused_at)}</span></p>
                        <p>Responsável: <span className="font-medium">{pauserNames[control?.paused_by ?? ""] ?? "—"}</span></p>
                      </>
                    )}
                    <div className="pt-1">
                      <PauseCompanyDialog
                        adminId={a.id}
                        companyName={a.nome}
                        workersCount={all.length}
                        control={control}
                        onDone={() => void reload()}
                      />
                    </div>
                  </div>

                  {list.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">Nenhum trabalhador para os filtros atuais.</p>
                  ) : (
                    list.map((w) => (
                      <div key={w.id} className="space-y-1">
                        <p className="text-xs font-medium flex items-center gap-1 flex-wrap">
                          {w.nome}
                          <AccessStatusBadge status={statusOf(w.id)} />
                        </p>

                        <WorkerAccessSummary
                          license={maps.licenseByWorker[w.id]}
                          lastPeriod={maps.lastPeriodByWorker[w.id]}
                          title="Licença"
                          companyPaused={isCompanyPaused(control)}
                        />

                        <div className="flex flex-wrap items-center gap-1">
                          <RenewAccessDialog
                            workerId={w.id}
                            workerName={w.nome}
                            companyName={a.nome}
                            license={maps.licenseByWorker[w.id]}
                            lastPeriod={maps.lastPeriodByWorker[w.id]}
                            onDone={() => void reload()}
                          />
                          <PauseAccessDialog
                            workerId={w.id}
                            workerName={w.nome}
                            companyName={a.nome}
                            license={maps.licenseByWorker[w.id]}
                            onDone={() => void reload()}
                          />
                          <AccessHistoryDialog
                            workerName={w.nome}
                            companyName={a.nome}
                            periods={maps.periodsByWorker[w.id] ?? []}
                          />
                        </div>
                      </div>
                    ))

                  )}
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        );
      })}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-2">
      <p className="text-[10px] text-muted-foreground truncate">{label}</p>
      <p className="text-sm font-semibold truncate">{value}</p>
    </div>
  );
}
