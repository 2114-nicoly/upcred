import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrency } from "@/lib/loan-utils";
import { normalizeMoney } from "@/lib/money";
import { CashGuardRequest, registerCashGuardHandler } from "@/lib/cash-guard";
import { useAuth } from "@/hooks/useAuth";
import { useEffectiveScope } from "@/hooks/useEffectiveScope";
import { fetchScopedActiveCash } from "@/lib/loan-cash";

/**
 * Modal ÚNICO de saldo insuficiente, usado por todas as telas.
 *
 * Nunca recalcula saldo: exibe exatamente os valores devolvidos pelo banco no
 * erro estruturado CASH_INSUFFICIENT. O aporte é sempre manual e confirmado
 * pelo usuário — a operação recusada NÃO é reexecutada automaticamente.
 */
export function CashGuardProvider({ children }: { children: React.ReactNode }) {
  const { workerId, adminId } = useAuth();
  const { effectiveWorkerId, effectiveAdminId, readOnly } = useEffectiveScope();
  const [req, setReq] = useState<CashGuardRequest | null>(null);
  const [adding, setAdding] = useState(false);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    registerCashGuardHandler((r) => {
      setReq(r);
      setAdding(false);
      setSubmitting(false);
      setAmount(String(r.info.missing_amount || ""));
    });
    return () => registerCashGuardHandler(null);
  }, []);

  if (!req) return <>{children}</>;

  const info = req.info;
  const targetWorker = req.scope?.workerId ?? effectiveWorkerId ?? workerId ?? null;
  const targetAdmin = req.scope?.adminId ?? effectiveAdminId ?? adminId ?? null;

  // Só é possível aportar no PRÓPRIO caixa: a RPC deriva o escopo do usuário
  // autenticado. Visualizando outro trabalhador (ou empresa), o aporte precisa
  // ser feito pelo responsável daquele caixa.
  const ownScopeMatches =
    (targetWorker ?? null) === (workerId ?? null) && (targetAdmin ?? null) === (adminId ?? null);
  const canAddMoney = !readOnly && ownScopeMatches;

  const close = () => { setReq(null); setAdding(false); setAmount(""); };

  const handleAdd = async () => {
    if (submitting) return;
    const value = normalizeMoney(String(amount).replace(/\./g, "").replace(",", "."));
    if (!(value > 0)) { toast.error("Informe um valor maior que zero"); return; }
    setSubmitting(true);
    try {
      const cash = await fetchScopedActiveCash({ workerId: targetWorker, adminId: targetAdmin });
      if (!cash?.cashDate) throw new Error("Não há caixa aberto para registrar a entrada.");
      const { error } = await supabase.rpc("register_manual_movement" as any, {
        p_cash_date: cash.cashDate,
        p_type: "entrada_manual",
        p_amount: value,
        p_observation: "Aporte para cobrir saldo insuficiente do caixa",
      } as any);
      if (error) throw error;
      toast.success("Dinheiro adicionado ao caixa. Confirme novamente a operação.");
      await req.onCashAdded?.();
      close();
    } catch (err: any) {
      toast.error(err?.message || "Erro ao adicionar dinheiro ao caixa");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      {children}
      <AlertDialog open onOpenChange={(o) => { if (!o) close(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Saldo insuficiente no caixa</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-1 text-sm">
                <div>Caixa disponível atual: <strong>{formatCurrency(info.available_cash)}</strong>.</div>
                <div>Valor da operação: <strong>{formatCurrency(info.operation_amount)}</strong>.</div>
                <div>Faltam: <strong>{formatCurrency(info.missing_amount)}</strong>.</div>
                <div>
                  {canAddMoney
                    ? "Adicione dinheiro ao Caixa Disponível para continuar."
                    : "Solicite ao administrador uma entrada de dinheiro no caixa para continuar."}
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>

          {adding && canAddMoney && (
            <div className="space-y-2">
              <Label htmlFor="cash-guard-amount">Valor da entrada</Label>
              <Input
                id="cash-guard-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0,00"
              />
              <p className="text-xs text-muted-foreground">
                A entrada será registrada no caixa da operação recusada e ficará auditada.
                A operação original não é executada automaticamente.
              </p>
            </div>
          )}

          <AlertDialogFooter>
            {adding && canAddMoney ? (
              <>
                <Button variant="outline" onClick={close} disabled={submitting}>Cancelar</Button>
                <Button onClick={handleAdd} disabled={submitting}>
                  {submitting ? "Registrando..." : "Confirmar entrada"}
                </Button>
              </>
            ) : (
              <>
                <AlertDialogCancel onClick={close}>Cancelar</AlertDialogCancel>
                {canAddMoney && (
                  <AlertDialogAction onClick={(e) => { e.preventDefault(); setAdding(true); }}>
                    Adicionar dinheiro ao caixa
                  </AlertDialogAction>
                )}
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default CashGuardProvider;
