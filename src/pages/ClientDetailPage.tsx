import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  formatCurrency,
  getLoanStatusColor,
  getStatusLabel,
  calculateOverdueDays,
  getPaymentTypeLabel,
  calculateLoanProgress,
} from "@/lib/loan-utils";
import { Plus, ChevronDown, History, Clock, Pencil, DollarSign, RefreshCw, Eye, FileText, MapPin, Phone, User } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import TransferClientDialog from "@/components/TransferClientDialog";
import { ArrowRightLeft } from "lucide-react";
import ClientForm, { ClientFormValues, emptyClientForm, validateClientForm } from "@/components/ClientForm";
import ClientAttachments from "@/components/ClientAttachments";
import ClientHistory from "@/components/ClientHistory";
import { logAction } from "@/lib/audit-utils";
import { isInstallmentCollectibleStatus, isLoanActive } from "@/lib/status-constants";

type Loan = {
  id: string;
  amount: number;
  total_amount: number;
  remaining_balance: number;
  installment_count: number;
  status: string;
  loan_date: string;
  payment_type: string;
  first_due_date: string | null;
  interest_type: string;
  interest_value: number;
  renewed_from_loan_id: string | null;
};

type Installment = {
  id: string;
  due_date: string;
  status: string;
  is_penalty: boolean;
  paid_amount: number;
  amount: number;
};

type Client = {
  id: string;
  name: string;
  full_name: string | null;
  phone: string | null;
  notes: string | null;
  client_code: number | null;
  address: string | null;
  doc_primary_type: string | null;
  doc_primary_number: string | null;
  doc_secondary_type: string | null;
  doc_secondary_number: string | null;
  worker_id?: string | null;
  admin_id?: string | null;
};

export default function ClientDetailPage() {
  const { clientId } = useParams();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [client, setClient] = useState<Client | null>(null);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [installmentsByLoan, setInstallmentsByLoan] = useState<Record<string, Installment[]>>({});
  const [renewedFromIds, setRenewedFromIds] = useState<Set<string>>(new Set());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [form, setForm] = useState<ClientFormValues>(emptyClientForm);

  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    try {
      const { data: c, error: cErr } = await supabase.from("clients").select("*").eq("id", clientId!).single();
      if (cErr || !c) {
        console.error("Error fetching client:", cErr);
        return;
      }
      setClient(c);
      const { data: l } = await supabase.from("loans").select("*").eq("client_id", clientId!).order("created_at", { ascending: false });
      const loansList = (l || []) as Loan[];
      setLoans(loansList);

      // Track which loans were renewed (i.e. another loan points to them)
      const renewedFrom = new Set<string>();
      loansList.forEach((loan) => {
        if (loan.renewed_from_loan_id) renewedFrom.add(loan.renewed_from_loan_id);
      });
      setRenewedFromIds(renewedFrom);

      if (loansList.length > 0) {
        const loanIds = loansList.map((loan) => loan.id);
        const { data: inst } = await supabase
          .from("installments")
          .select("id, due_date, status, is_penalty, loan_id, paid_amount, amount")
          .in("loan_id", loanIds);

        const grouped: Record<string, Installment[]> = {};
        (inst || []).forEach((i: any) => {
          if (!grouped[i.loan_id]) grouped[i.loan_id] = [];
          grouped[i.loan_id].push(i);
        });
        setInstallmentsByLoan(grouped);
      }
    } catch (err) {
      console.error("Error in ClientDetailPage fetchData:", err);
      toast.error("Erro ao carregar dados do cliente");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, [clientId]);

  const getOverdueDays = (loan: Loan): number => {
    const insts = installmentsByLoan[loan.id] || [];
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const overdueInsts = insts
      .filter((i) => !i.is_penalty && isInstallmentCollectibleStatus(i.status))
      .filter((i) => new Date(i.due_date + "T12:00:00") < today)
      .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
    if (overdueInsts.length === 0) return 0;
    return calculateOverdueDays(overdueInsts[0].due_date, loan.payment_type);
  };

  const getNextDueDate = (loan: Loan): string | null => {
    const insts = (installmentsByLoan[loan.id] || []).filter((i) => !i.is_penalty && isInstallmentCollectibleStatus(i.status));
    if (insts.length === 0) return null;
    return insts.sort((a, b) => a.due_date.localeCompare(b.due_date))[0].due_date;
  };

  const getInstallmentValue = (loan: Loan): number => {
    const insts = (installmentsByLoan[loan.id] || []).filter((i) => !i.is_penalty);
    return insts.length > 0 ? Number(insts[0].amount) : 0;
  };

  const handleEditClient = async () => {
    if (!client) return;
    const err = validateClientForm(form);
    if (err) { toast.error(err); return; }
    const oldVal = {
      name: client.name, phone: client.phone, notes: client.notes,
      full_name: client.full_name, address: client.address,
      doc_primary_type: client.doc_primary_type, doc_primary_number: client.doc_primary_number,
      doc_secondary_type: client.doc_secondary_type, doc_secondary_number: client.doc_secondary_number,
    };
    const newVal = {
      name: form.name.trim(), phone: form.phone || null, notes: form.notes || null,
      full_name: form.full_name || null, address: form.address || null,
      doc_primary_type: form.doc_primary_type || null, doc_primary_number: form.doc_primary_number || null,
      doc_secondary_type: form.doc_secondary_type || null, doc_secondary_number: form.doc_secondary_number || null,
    };
    const { error } = await supabase.from("clients").update(newVal as any).eq("id", clientId!);
    if (error) { toast.error("Erro ao editar"); return; }
    logAction("editar_cliente", "client", clientId!, oldVal, newVal);
    toast.success("Cliente atualizado!");
    setEditOpen(false);
    fetchData();
  };

  const openEdit = () => {
    if (!client) return;
    setForm({
      name: client.name || "",
      full_name: client.full_name || "",
      phone: client.phone || "",
      address: client.address || "",
      doc_primary_type: (client.doc_primary_type as any) || "CPF",
      doc_primary_number: client.doc_primary_number || "",
      doc_secondary_type: (client.doc_secondary_type as any) || "",
      doc_secondary_number: client.doc_secondary_number || "",
      notes: client.notes || "",
    });
    setEditOpen(true);
  };

  const activeLoans = loans.filter(isLoanActive);
  const activeLoan = activeLoans[0] || null;
  const historyLoans = loans.filter(
    (l) => l.status === "paid" || l.status === "cancelled" || l.status === "renegotiated"
  );

  if (loading || !client) return <p className="p-4 text-center text-muted-foreground">Carregando...</p>;

  return (
    <div className="mx-auto max-w-lg p-4 space-y-4 pb-24">

      {/* Header: Client info */}
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold truncate">{client.name}</h1>
          {client.full_name && client.full_name !== client.name && (
            <p className="text-sm text-muted-foreground">{client.full_name}</p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <Button size="sm" variant="outline" onClick={openEdit}>
            <Pencil className="mr-1 h-3 w-3" /> Editar
          </Button>
          {isAdmin && (
            <Button size="sm" variant="outline" onClick={() => setTransferOpen(true)}>
              <ArrowRightLeft className="mr-1 h-3 w-3" /> Transferir
            </Button>
          )}
        </div>
      </div>

      {/* Documentos */}
      {(client.doc_primary_number || client.doc_secondary_number) && (
        <Card>
          <CardContent className="p-3 space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground uppercase flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5" /> Documentos
            </p>
            {client.doc_primary_number && (
              <p className="text-sm"><span className="text-muted-foreground">{client.doc_primary_type}:</span> <span className="font-medium">{client.doc_primary_number}</span></p>
            )}
            {client.doc_secondary_number && (
              <p className="text-sm"><span className="text-muted-foreground">{client.doc_secondary_type}:</span> <span className="font-medium">{client.doc_secondary_number}</span></p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Endereço e contato */}
      {(client.phone || client.address) && (
        <Card>
          <CardContent className="p-3 space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground uppercase">Endereço e contato</p>
            {client.phone && (
              <p className="text-sm flex items-start gap-1.5"><Phone className="h-3.5 w-3.5 mt-0.5 text-muted-foreground" /> {client.phone}</p>
            )}
            {client.address && (
              <p className="text-sm flex items-start gap-1.5"><MapPin className="h-3.5 w-3.5 mt-0.5 text-muted-foreground" /> {client.address}</p>
            )}
          </CardContent>
        </Card>
      )}

      {client.notes && (
        <Card><CardContent className="p-3 text-xs text-muted-foreground">{client.notes}</CardContent></Card>
      )}

      {isAdmin && client && (
        <TransferClientDialog
          open={transferOpen}
          onOpenChange={setTransferOpen}
          clientId={client.id}
          clientName={client.name}
          currentWorkerId={client.worker_id ?? null}
          onTransferred={fetchData}
        />
      )}

      {/* Active Loan section */}
      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Empréstimo Ativo</h2>

        {!activeLoan ? (
          <Card>
            <CardContent className="p-6 text-center space-y-3">
              <p className="text-muted-foreground">Nenhum empréstimo ativo</p>
              <Link to={`/clients/${clientId}/new-loan`}>
                <Button size="sm">
                  <Plus className="mr-1 h-4 w-4" /> Criar Empréstimo
                </Button>
              </Link>
            </CardContent>
          </Card>
        ) : (() => {
          const overdueDays = getOverdueDays(activeLoan);
          const progress = calculateLoanProgress({
            totalAmount: Number(activeLoan.total_amount),
            remainingBalance: Number(activeLoan.remaining_balance),
            installmentCount: activeLoan.installment_count,
          });
          const nextDue = getNextDueDate(activeLoan);
          const instValue = getInstallmentValue(activeLoan);
          const remaining = Number(activeLoan.remaining_balance);
          const status = overdueDays > 0 ? "overdue" : activeLoan.status;

          return (
            <Card className="overflow-hidden">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">Saldo restante</p>
                    <p className="text-2xl font-extrabold tabular-nums">{formatCurrency(remaining)}</p>
                  </div>
                  <Badge className={getLoanStatusColor(status)}>{getStatusLabel(status)}</Badge>
                </div>

                {overdueDays > 0 && (
                  <div className="flex items-center gap-1 text-xs font-semibold text-destructive">
                    <Clock className="h-3 w-3" />
                    {overdueDays} dia{overdueDays > 1 ? "s" : ""} em atraso
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <p className="text-muted-foreground">Total pago</p>
                    <p className="font-semibold text-success tabular-nums">{formatCurrency(progress.totalPaid)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Valor total</p>
                    <p className="font-semibold tabular-nums">{formatCurrency(Number(activeLoan.total_amount))}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Parcela</p>
                    <p className="font-semibold tabular-nums">{formatCurrency(instValue)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Próximo vencimento</p>
                    <p className="font-semibold tabular-nums">
                      {nextDue ? format(new Date(nextDue + "T12:00:00"), "dd/MM/yyyy") : "—"}
                    </p>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                  <span>{progress.progressFormatted} parcelas • {getPaymentTypeLabel(activeLoan.payment_type, activeLoan.first_due_date)}</span>
                </div>
                <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${overdueDays > 0 ? "bg-destructive" : "bg-primary"}`}
                    style={{ width: `${progress.progressPercent}%` }}
                  />
                </div>

                <div className="flex gap-2 pt-1">
                  <Button size="sm" className="flex-1" onClick={() => navigate(`/loans/${activeLoan.id}`)}>
                    <DollarSign className="mr-1 h-3.5 w-3.5" /> Pagar
                  </Button>
                  <Button size="sm" variant="secondary" className="flex-1" onClick={() => navigate(`/clients/${clientId}/new-loan?renewFrom=${activeLoan.id}`)}>
                    <RefreshCw className="mr-1 h-3.5 w-3.5" /> Renovar
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => navigate(`/loans/${activeLoan.id}`)}>
                    <Eye className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })()}
      </div>

      {/* History */}
      {historyLoans.length > 0 && (
        <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="outline" className="w-full">
              <History className="mr-2 h-4 w-4" /> Histórico de Empréstimos ({historyLoans.length})
              <ChevronDown className={`ml-auto h-4 w-4 transition-transform ${historyOpen ? "rotate-180" : ""}`} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 space-y-2">
            {historyLoans.map((loan) => {
              const insts = (installmentsByLoan[loan.id] || []).filter((i) => !i.is_penalty);
              const totalPaid = insts.reduce((s, i) => s + Number(i.paid_amount), 0);
              const lastPaid = insts
                .filter((i) => i.status === "paid")
                .map((i) => i.due_date)
                .sort()
                .pop();
              const wasRenewed = renewedFromIds.has(loan.id);
              return (
                <Link key={loan.id} to={`/loans/${loan.id}`}>
                  <Card className="cursor-pointer transition-opacity hover:bg-accent/50">
                    <CardContent className="p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="font-bold text-sm tabular-nums">{formatCurrency(Number(loan.total_amount))}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {format(new Date(loan.loan_date + "T12:00:00"), "dd/MM/yyyy")}
                            {lastPaid && ` → ${format(new Date(lastPaid + "T12:00:00"), "dd/MM/yyyy")}`}
                          </p>
                          <p className="text-[11px] text-success">Pago: {formatCurrency(totalPaid)}</p>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <Badge className={getLoanStatusColor(loan.status)}>{getStatusLabel(loan.status)}</Badge>
                          {wasRenewed && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">Renovado</Badge>
                          )}
                          {!wasRenewed && loan.renewed_from_loan_id && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">Renovação</Badge>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Anexos */}
      <ClientAttachments clientId={client.id} adminId={client.admin_id ?? null} />

      {/* Histórico de alterações */}
      <ClientHistory clientId={client.id} />

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Editar Cliente</DialogTitle></DialogHeader>
          <ClientForm value={form} onChange={setForm} submitLabel="Salvar" onSubmit={handleEditClient} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
