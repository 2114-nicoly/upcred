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
import { CompanyAccessControl, formatDateTime } from "@/lib/access-control";

type Props = {
  adminId: string;
  companyName: string;
  workersCount: number;
  control?: CompanyAccessControl | null;
  onDone?: () => void;
};

/**
 * Pausa e reativação manual do acesso da EMPRESA — exclusivo do SuperAdministrador.
 * Altera somente company_access_controls; nenhum dado operacional é tocado.
 */
export default function PauseCompanyDialog({ adminId, companyName, workersCount, control, onDone }: Props) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reason, setReason] = useState("");

  const paused = control?.manual_status === "paused";

  async function submit() {
    if (saving) return;
    if (!paused && reason.trim().length < 3) return toast.error("Informe o motivo da pausa");
    setSaving(true);
    try {
      const fn = paused ? "reactivate-company-access" : "pause-company-access";
      const { data, error } = await supabase.functions.invoke(fn, {
        body: paused ? { admin_id: adminId } : { admin_id: adminId, reason: reason.trim() },
      });
      const err = (data as any)?.error;
      if (error || err) throw new Error(err || error?.message || "Falha na operação");
      toast.success(paused ? "Empresa reativada" : "Empresa pausada");
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
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
      >
        {paused
          ? <><PlayCircle className="h-3.5 w-3.5 mr-1" /> Reativar empresa</>
          : <><PauseCircle className="h-3.5 w-3.5 mr-1" /> Pausar empresa</>}
      </Button>

      <Dialog open={open} onOpenChange={(o) => !saving && setOpen(o)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">{paused ? "Reativar empresa" : "Pausar empresa"}</DialogTitle>
            <DialogDescription className="text-xs">{companyName}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-md border p-2 text-[11px] space-y-0.5">
              <p>Empresa: <span className="font-medium">{companyName}</span></p>
              <p>Trabalhadores vinculados: <span className="font-medium">{workersCount}</span></p>
              {paused && (
                <>
                  <p>Motivo atual: <span className="font-medium">{control?.pause_reason || "—"}</span></p>
                  <p>Pausada em: <span className="font-medium">{formatDateTime(control?.paused_at)}</span></p>
                </>
              )}
            </div>

            {!paused ? (
              <>
                <div>
                  <Label className="text-xs">Motivo da pausa *</Label>
                  <Textarea
                    rows={3}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Ex.: mensalidade em aberto"
                    className="text-xs"
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  A empresa e seus trabalhadores perderão o acesso somente enquanto o bloqueio automático
                  estiver ativado. Nenhum dado será excluído.
                </p>
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                A empresa volta a acessar normalmente. Licenças, vencimentos, pausas individuais e
                históricos permanecem exatamente como estão.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" disabled={saving} onClick={() => setOpen(false)}>Cancelar</Button>
            <Button size="sm" disabled={saving} onClick={() => void submit()}>
              {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              {paused ? "Reativar empresa" : "Pausar empresa"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
