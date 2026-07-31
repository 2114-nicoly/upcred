import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, CalendarCog } from "lucide-react";
import { toast } from "sonner";
import { WorkerAccessLicense, formatAccessDate } from "@/lib/access-control";

type Props = {
  workerId: string;
  workerName: string;
  companyName?: string | null;
  license?: WorkerAccessLicense | null;
  onDone?: () => void;
};

/** Correção manual das datas do período atual — exclusiva do SuperAdministrador. */
export default function EditAccessPeriodDialog({
  workerId, workerName, companyName, license, onDone,
}: Props) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  if (!license) return null;

  const currentStart = license.access_start ? String(license.access_start).slice(0, 10) : "";
  const currentEnd = license.access_end ? String(license.access_end).slice(0, 10) : "";

  function handleOpenChange(o: boolean) {
    if (saving) return;
    if (o) { setStart(currentStart); setEnd(currentEnd); }
    setOpen(o);
  }

  async function submit() {
    if (saving) return;
    if (!start) return toast.error("Informe a data inicial");
    if (!end) return toast.error("Informe a data final");
    if (end < start) return toast.error("A data final não pode ser anterior à data inicial");

    setSaving(true);
    try {
      const { data, error } = await supabase.functions.invoke("edit-worker-access-period", {
        body: { worker_id: workerId, access_start: start, access_end: end },
      });
      const err = (data as any)?.error;
      if (error || err) throw new Error(err || error?.message || "Falha ao editar o período");
      toast.success(`Período atualizado: ${formatAccessDate(start)} → ${formatAccessDate(end)}`);
      setOpen(false);
      onDone?.();
    } catch (e: any) {
      toast.error(e?.message || "Falha ao editar o período");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => handleOpenChange(true)}>
        <CalendarCog className="h-3.5 w-3.5 mr-1" /> Editar período atual
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">Editar período atual</DialogTitle>
            <DialogDescription className="text-xs">
              {workerName}{companyName ? ` · ${companyName}` : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-md border p-2 text-[11px] space-y-0.5">
              <p>Data inicial atual: <span className="font-medium">{formatAccessDate(currentStart)}</span></p>
              <p>Data final atual: <span className="font-medium">{formatAccessDate(currentEnd)}</span></p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Data inicial</Label>
                <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs">Data final</Label>
                <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
              </div>
            </div>

            <p className="text-[10px] text-muted-foreground">
              Correção manual do período: não registra renovação nem pagamento e não altera
              valor mensal, pausas ou credenciais.
            </p>
          </div>

          <DialogFooter>
            <Button className="w-full" onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Salvar período"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
