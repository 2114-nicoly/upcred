import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Loader2, ChevronDown, Building2 } from "lucide-react";
import AccessStatusBadge from "@/components/access/AccessStatusBadge";
import WorkerAccessSummary from "@/components/access/WorkerAccessSummary";
import WorkerRequestsSuperAdminSection from "@/components/access/WorkerRequestsSuperAdminSection";
import RenewAccessDialog from "@/components/access/RenewAccessDialog";


import {
  AccessMaps,
  AccessStatus,
  ACCESS_STATUS_FILTERS,
  companyStatusLabel,
  fetchEnforcementEnabled,
  formatMoney,
  getAccessStatus,
  loadAccessMaps,
} from "@/lib/access-control";

type AdminRow = { id: string; nome: string };
type WorkerRow = { id: string; nome: string; parent_admin_id: string | null };

/** Aba "Acessos" — visão global, somente leitura nesta etapa. */
export default function AccessManagementTab() {
  const [loading, setLoading] = useState(true);
  const [enforcement, setEnforcement] = useState(false);
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [workers, setWorkers] = useState<WorkerRow[]>([]);
  const [maps, setMaps] = useState<AccessMaps>(EMPTY_ACCESS_MAPS);
  const [companyFilter, setCompanyFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<AccessStatus | "all">("all");

  const reload = async () => {
    setLoading(true);
    try {
      const [enf, adminsRes, workersRes, m] = await Promise.all([
        fetchEnforcementEnabled(),
        supabase.rpc("super_admin_list_admins" as any),
        supabase.rpc("list_workers_by_admin" as any, { p_admin_id: null, p_include_archived: false }),
        loadAccessMaps(),
      ]);
      setEnforcement(enf);
      setAdmins(((adminsRes.data as any[]) ?? []).map((a) => ({ id: a.id, nome: a.nome })));
      setWorkers(((workersRes.data as any[]) ?? []).map((w) => ({ id: w.id, nome: w.nome, parent_admin_id: w.parent_admin_id ?? null })));
      setMaps(m);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, []);


  const statusOf = (workerId: string) => getAccessStatus(maps.licenseByWorker[workerId]);

  const visibleWorkers = useMemo(
    () =>
      workers.filter((w) => {
        if (companyFilter !== "all" && w.parent_admin_id !== companyFilter) return false;
        if (statusFilter !== "all" && statusOf(w.id) !== statusFilter) return false;
        return true;
      }),
    [workers, companyFilter, statusFilter, maps],
  );

  const totals = useMemo(() => {
    const scoped = workers.filter((w) => companyFilter === "all" || w.parent_admin_id === companyFilter);
    let configured = 0, unconfigured = 0, active = 0, expired = 0, paused = 0, monthly = 0;
    scoped.forEach((w) => {
      const lic = maps.licenseByWorker[w.id];
      if (lic) { configured++; monthly += Number(lic.monthly_price ?? 0); } else unconfigured++;
      const s = statusOf(w.id);
      if (s === "active" || s === "expiring") active++;
      if (s === "expired") expired++;
      if (s === "paused") paused++;
    });
    return {
      companies: companyFilter === "all" ? admins.length : 1,
      workers: scoped.length,
      configured, unconfigured, active, expired, paused, monthly,
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

      {!enforcement && (
        <Badge variant="outline" className="text-[10px]">Bloqueio automático desativado</Badge>
      )}


      <Card>
        <CardContent className="p-3 grid grid-cols-2 gap-2 text-[11px]">
          <Metric label="Empresas" value={String(totals.companies)} />
          <Metric label="Trabalhadores" value={String(totals.workers)} />
          <Metric label="Licenças configuradas" value={String(totals.configured)} />
          <Metric label="Não configuradas" value={String(totals.unconfigured)} />
          <Metric label="Ativos" value={String(totals.active)} />
          <Metric label="Expirados" value={String(totals.expired)} />
          <Metric label="Pausados" value={String(totals.paused)} />
          <Metric label="Valor mensal configurado" value={formatMoney(totals.monthly)} />
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
                        />
                        <RenewAccessDialog
                          workerId={w.id}
                          workerName={w.nome}
                          license={maps.licenseByWorker[w.id]}
                          onDone={() => void reload()}
                        />
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
