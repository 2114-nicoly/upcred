import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, PauseCircle, PlayCircle } from "lucide-react";
import { toast } from "sonner";
import AccessStatusBadge from "@/components/access/AccessStatusBadge";
import {
  WorkerAccessLicense, formatAccessDate, formatMoney, getAccessStatus,
} from "@/lib/access-control";

type Props = {
  workerId: string;
  workerName: string;
  companyName?: string | null;
  license?: WorkerAccessLicense | null;
  onDone?: () => void;
};

/**
 * Pausa e reativação manual da licença — exclusivo do SuperAdministrador.
 * Não bloqueia login, não altera datas, preço, histórico ou dados operacionais.
 */
export default function PauseAccessDialog({ workerId, workerName, companyName, license, onDone }: Props) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reason, setReason] = useState("");

  if (!license) return null;

  const paused = license.manual_status === "paused";
  const status = getAccessStatus(license);

  async function submit() {
    if (saving) return;
    if (!paused && reason.trim().length < 3) return toast.error("Informe o motivo da pausa");
    setSaving(true);
    try {
      const fn = paused ? "reactivate-worker-access" : "pause-worker-access";
      const { data, error } = await supabase.functions.invoke(fn, {
        body: paused ? { worker_id: workerId } : { worker_id: workerId, reason: reason.trim() },
      });
      const err = (data as any)?.error;
      if (error || err) throw new Error(err || error?.message || "Falha na operação");
      toast.success(paused ? "Acesso reativado" : "Acesso pausado");
      setOpen(false);
      setReason("");
      onDone?.();
    } catch (e: any) {
      toast.error(e?.message || "Não foi possível concluir a operação");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-[11px]"
        onClick={() => setOpen(true)}
      >
        {paused
          ? <><PlayCircle className="h-3.5 w-3.5 mr-1" /> Reativar acesso</>
          : <><PauseCircle className="h-3.5 w-3.5 mr-1" /> Pausar acesso</>}
      </Button>

      <Dialog open={open} onOpenChange={(o) => !saving && setOpen(o)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">{paused ? "Reativar acesso" : "Pausar acesso"}</DialogTitle>
            <DialogDescription className="text-xs">
              {workerName}{companyName ? ` · ${companyName}` : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-md border p-2 text-[11px] space-y-0.5">
              <p className="flex items-center gap-1">Situação atual: <AccessStatusBadge status={status} /></p>
              <p>Ativo até: <span className="font-medium">{formatAccessDate(license.access_end)}</span></p>
              <p>Valor mensal: <span className="font-medium">{formatMoney(license.monthly_price)}</span></p>
              {paused && license.pause_reason && (
                <p>Motivo atual: <span className="font-medium">{license.pause_reason}</span></p>
              )}
            </div>

            {!paused && (
              <div>
                <Label className="text-xs">Motivo da pausa *</Label>
                <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: mensalidade em aberto" />
              </div>
            )}

            <p className="text-[10px] text-muted-foreground">
              {paused
                ? "As datas da licença são preservadas. Se o período já venceu, o status continuará “Expirado” — renove separadamente."
                : "A pausa não bloqueia o login nesta etapa e não altera datas, valores, histórico, clientes, empréstimos ou caixa."}
            </p>
          </div>

          <DialogFooter>
            <Button className="w-full" onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : paused ? "Confirmar reativação" : "Confirmar pausa"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
