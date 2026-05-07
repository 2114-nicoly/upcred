import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/loan-utils";
import { getMovementTypeLabel } from "@/lib/cash-utils";
import { editPayment, reversePayment } from "@/lib/payment-utils";
import { CalendarCheck, ChevronDown, ChevronUp, Pencil, Trash2 } from "lucide-react";
import { format, isToday, isYesterday } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";
import { useConfirm } from "@/hooks/useConfirm";
import { ListSkeleton, EmptyState } from "@/components/LoadingSkeleton";

type PaymentMovement = {
  movementId: string;
  eventId: string;
  type: string;
  amount: number;
  cashDate: string;
  observation: string | null;
  createdAt: string;
  loanId: string | null;
  clientId: string | null;
  clientName: string;
};

function getDayLabel(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00");
  if (isToday(date)) return "Hoje";
  if (isYesterday(date)) return "Ontem";
  return format(date, "EEEE, dd/MM/yyyy", { locale: ptBR });
}

export default function PaymentHistoryPage() {
  const confirm = useConfirm();
  const [paymentsByDay, setPaymentsByDay] = useState<Record<string, PaymentMovement[]>>({});
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editPaymentEntry, setEditPaymentEntry] = useState<PaymentMovement | null>(null);
  const [editPaidAmount, setEditPaidAmount] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const { data: movements, error } = await supabase
        .from("cash_movements")
        .select("id, type, amount, cash_date, observation, created_at, loan_id, client_id, daily_event_id")
        .in("type", ["recebimento_normal", "recebimento_multa"])
        .order("cash_date", { ascending: false })
        .order("created_at", { ascending: false });

      if (error) throw error;

      const clientIds = [...new Set((movements || []).map((m: any) => m.client_id).filter(Boolean))];
      const clientMap = new Map<string, string>();
      if (clientIds.length > 0) {
        const { data: clients } = await supabase.from("clients").select("id, name").in("id", clientIds);
        for (const client of clients || []) clientMap.set(client.id, client.name);
      }

      const grouped: Record<string, PaymentMovement[]> = {};
      ((movements as any[]) || []).forEach((movement) => {
        const day = movement.cash_date;
        if (!grouped[day]) grouped[day] = [];
        grouped[day].push({
          movementId: movement.id,
          eventId: movement.daily_event_id || "",
          type: movement.type,
          amount: Number(movement.amount),
          cashDate: movement.cash_date,
          observation: movement.observation,
          createdAt: movement.created_at,
          loanId: movement.loan_id,
          clientId: movement.client_id,
          clientName: clientMap.get(movement.client_id) || "Cliente",
        });
      });
      setPaymentsByDay(grouped);
    } catch (err: any) {
      console.error("PaymentHistoryPage fetchData error:", err);
      toast.error(err?.message || "Erro ao carregar histórico");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const handleUndoPayment = async (entry: PaymentMovement) => {
    if (isSubmitting) return;
    if (!confirm(`Desfazer lançamento de ${formatCurrency(entry.amount)}?`)) return;
    setIsSubmitting(true);
    try {
      await reversePayment({ movementId: entry.movementId });
      toast.success("Pagamento desfeito!");
      await fetchData();
    } catch (err: any) {
      console.error("handleUndoPayment error:", err);
      toast.error(err?.message || "Erro ao desfazer pagamento");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEditPayment = async () => {
    if (!editPaymentEntry || isSubmitting) return;
    if (editPaymentEntry.type !== "recebimento_normal") {
      toast.error("Edição automática está disponível apenas para pagamento normal.");
      return;
    }
    if (!editPaymentEntry.loanId || !editPaymentEntry.clientId) {
      toast.error("Lançamento sem vínculo suficiente para edição segura.");
      return;
    }

    const newAmount = parseFloat(editPaidAmount);
    if (isNaN(newAmount) || newAmount <= 0) { toast.error("Valor inválido"); return; }

    setIsSubmitting(true);
    try {
      await editPayment({
        loanId: editPaymentEntry.loanId,
        clientId: editPaymentEntry.clientId,
        clientName: editPaymentEntry.clientName,
        cashDate: editPaymentEntry.cashDate,
        newAmount,
        origin: "historico_pagamentos",
        movementId: editPaymentEntry.movementId,
      });
      toast.success("Pagamento atualizado!");
      setEditPaymentEntry(null);
      setEditPaidAmount("");
      await fetchData();
    } catch (err: any) {
      console.error("handleEditPayment error:", err);
      toast.error(err?.message || "Erro ao editar pagamento");
    } finally {
      setIsSubmitting(false);
    }
  };

  const days = Object.keys(paymentsByDay).sort((a, b) => b.localeCompare(a));

  return (
    <div className="mx-auto max-w-lg p-4">
      {loading ? (
        <ListSkeleton count={4} />
      ) : days.length === 0 ? (
        <EmptyState icon={CalendarCheck} message="Nenhum pagamento registrado" />
      ) : (
        <div className="space-y-2">
          {days.map((day) => {
            const payments = paymentsByDay[day];
            const total = payments.reduce((s, payment) => s + payment.amount, 0);
            const isExpanded = expandedDay === day;
            return (
              <Card key={day}>
                <button className="flex w-full items-center justify-between p-4 text-left" onClick={() => setExpandedDay(isExpanded ? null : day)}>
                  <div>
                    <p className="font-semibold capitalize">{getDayLabel(day)}</p>
                    <p className="text-sm text-muted-foreground">{payments.length} lançamento(s) • {formatCurrency(total)}</p>
                  </div>
                  {isExpanded ? <ChevronUp className="h-5 w-5 text-muted-foreground" /> : <ChevronDown className="h-5 w-5 text-muted-foreground" />}
                </button>
                {isExpanded && (
                  <CardContent className="space-y-2 border-t pt-3">
                    {payments.map((payment) => (
                      <div key={payment.movementId} className="flex items-center justify-between rounded-lg bg-accent p-3">
                        <div>
                          <p className="font-medium">{payment.clientName}</p>
                          <p className="text-sm text-muted-foreground">
                            {getMovementTypeLabel(payment.type)} • {formatCurrency(payment.amount)}
                          </p>
                          {payment.observation && <p className="text-xs text-muted-foreground italic">{payment.observation}</p>}
                        </div>
                        <div className="flex items-center gap-1">
                          <Badge className={payment.type === "recebimento_multa" ? "bg-warning text-warning-foreground" : "bg-success text-success-foreground"}>
                            {payment.type === "recebimento_multa" ? "Multa" : "Pago"}
                          </Badge>
                          {payment.type === "recebimento_normal" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0"
                              onClick={() => {
                                setEditPaymentEntry(payment);
                                setEditPaidAmount(String(payment.amount));
                              }}
                              disabled={isSubmitting}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-destructive"
                            onClick={() => handleUndoPayment(payment)}
                            disabled={isSubmitting}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={!!editPaymentEntry} onOpenChange={(open) => { if (!open) setEditPaymentEntry(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Editar Pagamento</DialogTitle></DialogHeader>
          {editPaymentEntry && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {editPaymentEntry.clientName} — {formatCurrency(editPaymentEntry.amount)}
              </p>
              <div>
                <Label>Valor pago</Label>
                <Input type="number" value={editPaidAmount} onChange={(e) => setEditPaidAmount(e.target.value)} />
              </div>
              <Button onClick={handleEditPayment} className="w-full" disabled={isSubmitting}>Salvar</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
