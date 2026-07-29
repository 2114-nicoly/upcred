import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CredentialsDialog, GeneratedCreds } from "@/components/CredentialsDialog";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { Loader2, Inbox } from "lucide-react";
import {
  WorkerCreationRequest, WorkerRequestStatus, formatDateTime, requestStatusLabel, requestStatusVariant,
  todayLocalISO, addMonthsLocal,
} from "@/lib/worker-requests";

type AdminRow = { id: string; nome: string };

/** Bloco "Solicitações de trabalhadores" no topo da aba Acessos do SuperAdministrador. */
export default function WorkerRequestsSuperAdminSection({ onChanged }: { onChanged?: () => void }) {
  const { user } = useAuth();
  const [rows, setRows] = useState<WorkerCreationRequest[]>([]);
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [companyFilter, setCompanyFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<WorkerRequestStatus | "all">("all");
  const [rejectTarget, setRejectTarget] = useState<WorkerCreationRequest | null>(null);
  const [reason, setReason] = useState("");
  const [working, setWorking] = useState(false);

  // Aprovação
  const [approveTarget, setApproveTarget] = useState<WorkerCreationRequest | null>(null);
  const [monthlyPrice, setMonthlyPrice] = useState("0");
  const [amountPaid, setAmountPaid] = useState("0");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [accessStart, setAccessStart] = useState(todayLocalISO());
  const [months, setMonths] = useState("1");
  const [customEnd, setCustomEnd] = useState(false);
  const [accessEnd, setAccessEnd] = useState("");
  const [approveNotes, setApproveNotes] = useState("");
  const [approving, setApproving] = useState(false);
  const [creds, setCreds] = useState<GeneratedCreds | null>(null);

  function openApprove(r: WorkerCreationRequest) {
    setApproveTarget(r);
    setMonthlyPrice("0"); setAmountPaid("0"); setPaymentMethod("");
    setAccessStart(todayLocalISO()); setMonths("1");
    setCustomEnd(false); setAccessEnd(""); setApproveNotes("");
  }

  const computedEnd = customEnd
    ? accessEnd
    : (accessStart && Number(months) > 0 ? addMonthsLocal(accessStart, Number(months)) : "");

  async function confirmApprove() {
    if (!approveTarget || approving) return;
    const mp = Number(monthlyPrice.replace(",", "."));
    const ap = Number(amountPaid.replace(",", "."));
    const mo = Number(months);
    if (!Number.isFinite(mp) || mp < 0) { toast({ title: "Valor mensal inválido", variant: "destructive" }); return; }
    if (!Number.isFinite(ap) || ap < 0) { toast({ title: "Valor pago inválido", variant: "destructive" }); return; }
    if (!accessStart) { toast({ title: "Informe a data inicial", variant: "destructive" }); return; }
    if (!customEnd && (!Number.isFinite(mo) || mo <= 0)) {
      toast({ title: "Quantidade de meses deve ser maior que zero", variant: "destructive" }); return;
    }
    if (customEnd && !accessEnd) { toast({ title: "Informe a data final", variant: "destructive" }); return; }
    if (computedEnd && computedEnd < accessStart) {
      toast({ title: "A data final não pode ser anterior à inicial", variant: "destructive" }); return;
    }

    setApproving(true);
    try {
      const { data, error } = await supabase.functions.invoke("approve-worker-request", {
        body: {
          request_id: approveTarget.id,
          monthly_price: mp,
          amount_paid: ap,
          payment_method: paymentMethod.trim() || null,
          access_start: accessStart,
          access_end: customEnd ? accessEnd : null,
          months_granted: customEnd ? null : mo,
          notes: approveNotes.trim() || null,
        },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || "Falha ao aprovar solicitação");

      setApproveTarget(null);
      setCreds({ nome: data.nome, role: "trabalhador", login: data.login, password: data.password, created_at: data.created_at });
      toast({ title: "Solicitação aprovada", description: "Trabalhador, licença e primeiro período criados." });
      load();
      onChanged?.();
    } catch (err: any) {
      toast({ title: "Erro ao aprovar", description: err.message, variant: "destructive" });
      load();
    } finally {
      setApproving(false);
    }
  }


  async function load() {
    setLoading(true);
    const [reqRes, adminsRes] = await Promise.all([
      supabase.from("worker_creation_requests" as any).select("*").order("requested_at", { ascending: false }),
      supabase.rpc("super_admin_list_admins" as any),
    ]);
    setRows(((reqRes.data as any[]) ?? []) as WorkerCreationRequest[]);
    setAdmins(((adminsRes.data as any[]) ?? []).map((a) => ({ id: a.id, nome: a.nome })));
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const adminName = (id: string) => admins.find((a) => a.id === id)?.nome ?? "—";

  const visible = useMemo(
    () => rows.filter((r) =>
      (companyFilter === "all" || r.admin_id === companyFilter) &&
      (statusFilter === "all" || r.status === statusFilter)),
    [rows, companyFilter, statusFilter],
  );

  const pendingCount = rows.filter((r) => r.status === "pending" || r.status === "processing").length;

  async function confirmReject() {
    if (!rejectTarget) return;
    if (!reason.trim()) { toast({ title: "Informe o motivo da negativa", variant: "destructive" }); return; }
    setWorking(true);
    try {
      const { error } = await supabase
        .from("worker_creation_requests" as any)
        .update({
          status: "rejected",
          rejection_reason: reason.trim(),
          reviewed_by: user?.id ?? null,
          reviewed_at: new Date().toISOString(),
        } as any)
        .eq("id", rejectTarget.id);
      if (error) throw error;
      toast({ title: "Solicitação negada" });
      setRejectTarget(null); setReason("");
      load();
    } catch (err: any) {
      toast({ title: "Erro ao negar", description: err.message, variant: "destructive" });
    } finally {
      setWorking(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold">Solicitações de trabalhadores</p>
          <Badge variant={pendingCount ? "secondary" : "outline"} className="text-[10px]">
            {pendingCount} pendente(s)
          </Badge>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Select value={companyFilter} onValueChange={setCompanyFilter}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Empresa" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as empresas</SelectItem>
              {admins.map((a) => <SelectItem key={a.id} value={a.id}>{a.nome}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as WorkerRequestStatus | "all")}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Situação" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as situações</SelectItem>
              <SelectItem value="pending">Em análise</SelectItem>
              <SelectItem value="approved">Aceitas</SelectItem>
              <SelectItem value="rejected">Negadas</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <div className="flex h-16 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin" /></div>
        ) : visible.length === 0 ? (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1">
            <Inbox className="h-3.5 w-3.5" /> Nenhuma solicitação para os filtros atuais.
          </p>
        ) : (
          <div className="space-y-2">
            {visible.map((r) => (
              <div key={r.id} className="rounded-md border p-2 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium">{r.worker_name}</span>
                  <Badge variant={requestStatusVariant(r.status)} className="text-[9px]">
                    {requestStatusLabel(r.status)}
                  </Badge>
                </div>
                <p className="text-[10px] text-muted-foreground">Empresa: {adminName(r.admin_id)}</p>
                <p className="text-[10px] text-muted-foreground">Solicitado em {formatDateTime(r.requested_at)}</p>
                {r.notes && <p className="text-[11px] text-muted-foreground whitespace-pre-line">{r.notes}</p>}
                {r.status === "rejected" && r.rejection_reason && (
                  <p className="text-[11px] text-destructive">Motivo: {r.rejection_reason}</p>
                )}
                {(r.status === "pending" || r.status === "processing") && (
                  <div className="flex gap-2 pt-1">
                    <Button
                      size="sm"
                      className="h-7 text-[11px]"
                      onClick={() => toast({ title: "A aprovação e a criação do acesso serão implementadas na próxima etapa." })}
                    >
                      Aprovar
                    </Button>
                    <Button size="sm" variant="destructive" className="h-7 text-[11px]"
                      onClick={() => { setRejectTarget(r); setReason(""); }}>
                      Negar
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={!!rejectTarget} onOpenChange={(v) => { if (!v) setRejectTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Negar solicitação</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Trabalhador solicitado: <span className="font-medium text-foreground">{rejectTarget?.worker_name}</span>
            </p>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Motivo da negativa (obrigatório)" />
          </div>
          <DialogFooter>
            <Button variant="destructive" onClick={confirmReject} disabled={working}>
              {working && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} Negar solicitação
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
