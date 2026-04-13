import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCurrency, getLoanStatusColor, getStatusLabel, calculateOverdueDays, getPaymentTypeLabel } from "@/lib/loan-utils";
import { ArrowLeft, Plus, ChevronDown, History, Clock, Pencil, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

type Loan = {
  id: string;
  amount: number;
  total_amount: number;
  installment_count: number;
  status: string;
  loan_date: string;
  payment_type: string;
  first_due_date: string | null;
  interest_type: string;
  interest_value: number;
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
  phone: string | null;
  notes: string | null;
  client_code: number | null;
};

export default function ClientDetailPage() {
  const { clientId } = useParams();
  const navigate = useNavigate();
  const [client, setClient] = useState<Client | null>(null);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [installmentsByLoan, setInstallmentsByLoan] = useState<Record<string, Installment[]>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editNotes, setEditNotes] = useState("");

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
      setLoans(l || []);

      if (l && l.length > 0) {
        const loanIds = l.map((loan: Loan) => loan.id);
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
      .filter((i) => !i.is_penalty && i.status !== "paid")
      .filter((i) => new Date(i.due_date + "T12:00:00") < today)
      .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
    if (overdueInsts.length === 0) return 0;
    return calculateOverdueDays(overdueInsts[0].due_date, loan.payment_type);
  };

  const getLoanProgress = (loan: Loan) => {
    const insts = (installmentsByLoan[loan.id] || []).filter((i) => !i.is_penalty);
    const totalPaid = insts.reduce((s, i) => s + Number(i.paid_amount), 0);
    const instValue = insts.length > 0 ? Number(insts[0].amount) : 1;
    const progress = totalPaid / instValue;
    const total = insts.length;
    const remaining = insts.reduce((s, i) => s + Number(i.amount), 0) - totalPaid;
    const penaltyInsts = (installmentsByLoan[loan.id] || []).filter((i) => i.is_penalty);
    const penaltyTotal = penaltyInsts.reduce((s, i) => s + Number(i.amount), 0);
    return { progress, total, remaining, penaltyTotal };
  };

  const handleEditClient = async () => {
    const { error } = await supabase.from("clients").update({
      name: editName.trim(),
      phone: editPhone || null,
      notes: editNotes || null,
    }).eq("id", clientId!);
    if (error) { toast.error("Erro ao editar"); return; }
    toast.success("Cliente atualizado!");
    setEditOpen(false);
    fetchData();
  };

  const handleDeleteLoan = async (loanId: string) => {
    if (!confirm("Excluir este empréstimo e todas as parcelas?")) return;
    await supabase.from("not_paid_marks").delete().eq("loan_id", loanId);
    await supabase.from("cash_movements").delete().eq("loan_id", loanId);
    await supabase.from("penalties").delete().eq("loan_id", loanId);
    await supabase.from("installments").delete().eq("loan_id", loanId);
    await supabase.from("loans").delete().eq("id", loanId);
    toast.success("Empréstimo excluído!");
    fetchData();
  };

  const activeLoans = loans.filter((l) => l.status !== "paid");
  const paidLoans = loans.filter((l) => l.status === "paid");

  // Removed local paymentTypeLabel — using getPaymentTypeLabel from loan-utils

  if (!client) return <p className="p-4 text-center">Carregando...</p>;

  return (
    <div className="mx-auto max-w-lg p-4">

      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">
            {client.client_code ? <span className="mr-1 text-sm text-muted-foreground">#{client.client_code}</span> : null}
            {client.name}
          </h1>
          {client.phone && <p className="text-sm text-muted-foreground">{client.phone}</p>}
          {client.notes && <p className="text-sm text-muted-foreground">{client.notes}</p>}
        </div>
        <Button size="sm" variant="outline" onClick={() => {
          setEditName(client.name);
          setEditPhone(client.phone || "");
          setEditNotes(client.notes || "");
          setEditOpen(true);
        }}>
          <Pencil className="mr-1 h-3 w-3" /> Editar
        </Button>
      </div>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Empréstimos Ativos</h2>
        <Link to={`/clients/${clientId}/new-loan`}>
          <Button size="sm"><Plus className="mr-1 h-4 w-4" /> Novo</Button>
        </Link>
      </div>

      {activeLoans.length === 0 ? (
        <p className="py-4 text-center text-muted-foreground">Nenhum empréstimo ativo</p>
      ) : (
        <div className="space-y-3">
          {activeLoans.map((loan) => {
            const overdueDays = getOverdueDays(loan);
            const { progress, total, remaining, penaltyTotal } = getLoanProgress(loan);
            return (
              <Card key={loan.id} className="overflow-hidden">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <Link to={`/loans/${loan.id}`} className="flex-1">
                      <p className="text-lg font-bold">{formatCurrency(Number(loan.total_amount))}</p>
                      <p className="text-sm text-muted-foreground">
                        {loan.installment_count}x • {getPaymentTypeLabel(loan.payment_type, loan.first_due_date)}
                      </p>
                      <p className="text-xs text-primary font-medium">
                        {progress % 1 === 0 ? progress : progress.toFixed(1)}/{total} • Resta: {formatCurrency(Math.max(0, remaining))}
                      </p>
                      {penaltyTotal > 0 && (
                        <p className="text-xs text-destructive">Multa: {formatCurrency(penaltyTotal)}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(loan.loan_date + "T12:00:00"), "dd/MM/yyyy")}
                      </p>
                      {overdueDays > 0 && (
                        <span className="mt-1 flex items-center gap-1 text-xs font-semibold text-destructive">
                          <Clock className="h-3 w-3" />
                          {overdueDays} dia{overdueDays > 1 ? "s" : ""} em atraso
                        </span>
                      )}
                    </Link>
                    <div className="flex flex-col items-end gap-1">
                      <Badge className={getLoanStatusColor(overdueDays > 0 ? "overdue" : loan.status)}>
                        {getStatusLabel(overdueDays > 0 ? "overdue" : loan.status)}
                      </Badge>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => handleDeleteLoan(loan.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {paidLoans.length > 0 && (
        <Collapsible open={historyOpen} onOpenChange={setHistoryOpen} className="mt-6">
          <CollapsibleTrigger asChild>
            <Button variant="outline" className="w-full">
              <History className="mr-2 h-4 w-4" /> Histórico ({paidLoans.length})
              <ChevronDown className={`ml-auto h-4 w-4 transition-transform ${historyOpen ? "rotate-180" : ""}`} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 space-y-3">
            {paidLoans.map((loan) => (
              <Link key={loan.id} to={`/loans/${loan.id}`}>
                <Card className="cursor-pointer opacity-75 transition-opacity hover:opacity-100">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-bold">{formatCurrency(Number(loan.total_amount))}</p>
                        <p className="text-sm text-muted-foreground">{loan.installment_count}x</p>
                      </div>
                      <Badge className={getLoanStatusColor(loan.status)}>{getStatusLabel(loan.status)}</Badge>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Editar Cliente</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div><Label>Nome *</Label><Input value={editName} onChange={(e) => setEditName(e.target.value)} /></div>
            <div><Label>Telefone</Label><Input value={editPhone} onChange={(e) => setEditPhone(e.target.value)} /></div>
            <div><Label>Observações</Label><Textarea value={editNotes} onChange={(e) => setEditNotes(e.target.value)} /></div>
            <Button onClick={handleEditClient} className="w-full">Salvar</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
