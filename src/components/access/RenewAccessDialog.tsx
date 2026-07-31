import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, CalendarPlus } from "lucide-react";
import { toast } from "sonner";
import AccessStatusBadge from "@/components/access/AccessStatusBadge";
import {
  WorkerAccessLicense, WorkerAccessPeriod, formatAccessDate, formatDateTime,
  formatMoney, getAccessStatus,
} from "@/lib/access-control";

/** YYYY-MM-DD local de hoje. */
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function nextDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return fmt(new Date(y, m - 1, d + 1));
}
/** Fim previsto: início + meses − 1 dia (mesma convenção da renovação). */
function addMonthsEnd(startStr: string, months: number): string {
  const [y, m, d] = startStr.split("-").map(Number);
  const end = new Date(y, m - 1 + months, d);
  end.setDate(end.getDate() - 1);
  return fmt(end);
}

type Props = {
  workerId: string;
  workerName: string;
  companyName?: string | null;
  license?: WorkerAccessLicense | null;
  lastPeriod?: WorkerAccessPeriod | null;
  onDone?: () => void;
};

/** Renovação de mensalidade — exclusiva do SuperAdministrador. */
export default function RenewAccessDialog({
  workerId, workerName, companyName, license, lastPeriod, onDone,
}: Props) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [monthlyPrice, setMonthlyPrice] = useState<string>(String(license?.monthly_price ?? ""));
  const [amountPaid, setAmountPaid] = useState<string>(String(license?.monthly_price ?? ""));
  const [months, setMonths] = useState<string>("1");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [notes, setNotes] = useState("");
  const [custom, setCustom] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  const status = getAccessStatus(license ?? null);
  const currentEnd = license?.access_end ? String(license.access_end).slice(0, 10) : null;
  const stillValid = !!currentEnd && currentEnd >= todayLocal();

  /** Sugestão inicial: dia seguinte ao vencimento (licença válida) ou hoje. */
  const suggestedStart = stillValid && currentEnd ? nextDay(currentEnd) : todayLocal();

  // Preenche a sugestão apenas ao abrir; depois o SuperAdmin controla o campo.
  function handleOpenChange(o: boolean) {
    if (saving) return;
    if (o) setStartDate(suggestedStart);
    setOpen(o);
  }

  const monthsNum = Number(months);
  const previewStart = startDate || suggestedStart;

  const previewEnd = useMemo(() => {
    if (custom) return customEnd || null;
    if (!Number.isFinite(monthsNum) || monthsNum <= 0) return null;
    return addMonthsEnd(previewStart, monthsNum);
  }, [custom, customEnd, monthsNum, previewStart]);

  async function submit() {
    if (saving) return; // trava clique duplo
    const price = Number(monthlyPrice.replace(",", "."));
    const paid = Number(amountPaid.replace(",", "."));
    const m = monthsNum;
    if (!Number.isFinite(price) || price < 0) return toast.error("Valor mensal inválido");
    if (!Number.isFinite(paid) || paid < 0) return toast.error("Valor pago inválido");
    if (!startDate) return toast.error("Informe a data inicial do novo período");
    const endOverride = custom ? customEnd : "";
    if (custom && !endOverride) return toast.error("Informe a data final do período personalizado");
    if (endOverride && endOverride < startDate) {
      return toast.error("A data final não pode ser anterior à data inicial");
    }
    if (!endOverride && (!Number.isFinite(m) || m <= 0)) return toast.error("Informe a quantidade de meses");
    const finalEnd = endOverride || addMonthsEnd(startDate, m);
    if (currentEnd && finalEnd < currentEnd) {
      return toast.error("A renovação não pode encurtar o acesso já concedido");
    }

    setSaving(true);
    try {
      const { data, error } = await supabase.functions.invoke("renew-worker-access", {
        body: {
          worker_id: workerId,
          monthly_price: price,
          amount_paid: paid,
          months_granted: custom ? null : m,
          payment_method: paymentMethod.trim() || null,
          start_date: startDate,
          custom_end_date: endOverride || null,
          notes: notes.trim() || null,
        },
      });
      const err = (data as any)?.error;
      if (error || err) throw new Error(err || error?.message || "Falha ao renovar");
      toast.success(`Acesso renovado até ${formatAccessDate((data as any).period_end)}`);
      setOpen(false);
      setNotes("");
      onDone?.();
    } catch (e: any) {
      toast.error(e?.message || "Falha ao renovar a licença");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => handleOpenChange(true)}>
        <CalendarPlus className="h-3.5 w-3.5 mr-1" /> Renovar acesso
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-sm max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base">Renovar acesso</DialogTitle>
            <DialogDescription className="text-xs">
              {workerName}{companyName ? ` · ${companyName}` : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-md border p-2 text-[11px] space-y-0.5">
              <p className="flex items-center gap-1">Situação atual: <AccessStatusBadge status={status} /></p>
              <p>Acesso atual até: <span className="font-medium">{formatAccessDate(currentEnd)}</span></p>
              <p>Valor mensal atual: <span className="font-medium">{formatMoney(license?.monthly_price)}</span></p>
              <p>
                Último pagamento:{" "}
                <span className="font-medium">
                  {lastPeriod
                    ? `${formatMoney(lastPeriod.amount_paid)} · ${formatDateTime(lastPeriod.paid_at ?? lastPeriod.created_at)}`
                    : "Nenhum registrado"}
                </span>
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Valor mensal</Label>
                <Input inputMode="decimal" value={monthlyPrice} onChange={(e) => setMonthlyPrice(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs">Valor pago</Label>
                <Input inputMode="decimal" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs">Meses</Label>
                <Input inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs">Forma de pagamento</Label>
                <Input value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} placeholder="Pix, dinheiro…" />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-md border p-2">
              <Label className="text-xs">Período personalizado</Label>
              <Switch checked={custom} onCheckedChange={setCustom} />
            </div>

            {custom && (
              <div className="grid grid-cols-2 gap-2">
                {!stillValid && (
                  <div>
                    <Label className="text-xs">Data inicial</Label>
                    <Input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
                  </div>
                )}
                <div>
                  <Label className="text-xs">Data final</Label>
                  <Input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
                </div>
              </div>
            )}

            <div>
              <Label className="text-xs">Observação</Label>
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>

            <div className="rounded-md border bg-muted/30 p-2 text-[11px] space-y-0.5">
              <p className="font-medium">Prévia</p>
              <p>Início do novo período: <span className="font-medium">{formatAccessDate(previewStart)}</span></p>
              <p>Final do novo período: <span className="font-medium">{previewEnd ? formatAccessDate(previewEnd) : "—"}</span></p>
              <p>Quantidade de meses: <span className="font-medium">{Number.isFinite(monthsNum) && monthsNum > 0 ? monthsNum : "—"}</span></p>
              <p>Valor pago: <span className="font-medium">{formatMoney(Number(amountPaid.replace(",", ".")) || 0)}</span></p>
              {stillValid && (
                <p className="text-muted-foreground">O novo período será acrescentado após o vencimento atual.</p>
              )}
            </div>

            <p className="text-[10px] text-muted-foreground">
              {status === "unconfigured"
                ? "Sem licença: será criada agora, sem alterar usuário, trabalhador ou credenciais."
                : "Esta mensalidade pertence ao sistema e não afeta o caixa operacional."}
            </p>
          </div>

          <DialogFooter>
            <Button className="w-full" onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirmar renovação"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
