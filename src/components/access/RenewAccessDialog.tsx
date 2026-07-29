import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, CalendarPlus } from "lucide-react";
import { toast } from "sonner";
import {
  WorkerAccessLicense, formatAccessDate, getAccessStatus,
} from "@/lib/access-control";

/** YYYY-MM-DD local de hoje. */
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function nextDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const n = new Date(y, m - 1, d + 1);
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

type Props = {
  workerId: string;
  workerName: string;
  license?: WorkerAccessLicense | null;
  onDone?: () => void;
};

/** Renovação de mensalidade — exclusiva do SuperAdministrador. */
export default function RenewAccessDialog({ workerId, workerName, license, onDone }: Props) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [monthlyPrice, setMonthlyPrice] = useState<string>(String(license?.monthly_price ?? ""));
  const [amountPaid, setAmountPaid] = useState<string>(String(license?.monthly_price ?? ""));
  const [months, setMonths] = useState<string>("1");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [notes, setNotes] = useState("");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  const status = getAccessStatus(license ?? null);
  const currentEnd = license?.access_end ? String(license.access_end).slice(0, 10) : null;
  const stillValid = !!currentEnd && currentEnd >= todayLocal();

  const previewStart = useMemo(() => {
    if (stillValid && currentEnd) return nextDay(currentEnd);
    return customStart || todayLocal();
  }, [stillValid, currentEnd, customStart]);

  async function submit() {
    if (saving) return; // trava clique duplo
    const price = Number(monthlyPrice.replace(",", "."));
    const paid = Number(amountPaid.replace(",", "."));
    const m = Number(months);
    if (!Number.isFinite(price) || price < 0) return toast.error("Valor mensal inválido");
    if (!Number.isFinite(paid) || paid < 0) return toast.error("Valor pago inválido");
    if (!customEnd && (!Number.isFinite(m) || m <= 0)) return toast.error("Informe a quantidade de meses");

    setSaving(true);
    try {
      const { data, error } = await supabase.functions.invoke("renew-worker-access", {
        body: {
          worker_id: workerId,
          monthly_price: price,
          amount_paid: paid,
          months_granted: m,
          payment_method: paymentMethod.trim() || null,
          custom_start_date: !stillValid && customStart ? customStart : null,
          custom_end_date: customEnd || null,
          notes: notes.trim() || null,
        },
      });
      const err = (data as any)?.error;
      if (error || err) throw new Error(err || error?.message || "Falha ao renovar");
      toast.success(`Licença renovada até ${formatAccessDate((data as any).period_end)}`);
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
      <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setOpen(true)}>
        <CalendarPlus className="h-3.5 w-3.5 mr-1" /> Renovar mensalidade
      </Button>

      <Dialog open={open} onOpenChange={(o) => !saving && setOpen(o)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Renovar mensalidade</DialogTitle>
            <DialogDescription>{workerName}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-md border p-2 text-[11px] space-y-0.5">
              <p>Acesso atual até: <span className="font-medium">{formatAccessDate(currentEnd)}</span></p>
              <p>
                Novo período inicia em: <span className="font-medium">{formatAccessDate(previewStart)}</span>
                {stillValid && " (renovação antecipada — dias já pagos são mantidos)"}
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
              {!stillValid && (
                <div>
                  <Label className="text-xs">Início personalizado</Label>
                  <Input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
                </div>
              )}
              <div>
                <Label className="text-xs">Fim personalizado</Label>
                <Input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
              </div>
            </div>

            <div>
              <Label className="text-xs">Observação</Label>
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
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
