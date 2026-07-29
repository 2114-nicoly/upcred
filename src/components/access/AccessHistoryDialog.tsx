import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { History } from "lucide-react";
import {
  WorkerAccessPeriod,
  fetchGrantorNames,
  formatAccessDate,
  formatDateTime,
  formatMoney,
} from "@/lib/access-control";

type Props = {
  workerName: string;
  companyName?: string | null;
  periods: WorkerAccessPeriod[];
  /** rótulo do botão */
  label?: string;
};

/**
 * Histórico de mensalidades — SOMENTE LEITURA.
 * Não permite editar, excluir ou alterar pagamentos antigos.
 */
export default function AccessHistoryDialog({ workerName, companyName, periods, label = "Ver histórico" }: Props) {
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});

  const ordered = useMemo(
    () =>
      [...periods].sort((a, b) => {
        const av = a.period_start ?? a.created_at;
        const bv = b.period_start ?? b.created_at;
        return String(bv).localeCompare(String(av));
      }),
    [periods],
  );

  useEffect(() => {
    if (!open) return;
    void fetchGrantorNames(ordered.map((p) => p.granted_by)).then(setNames);
  }, [open, ordered]);

  return (
    <>
      <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => setOpen(true)}>
        <History className="h-3.5 w-3.5 mr-1" /> {label}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">Histórico de mensalidades</DialogTitle>
            <DialogDescription className="text-xs">
              {workerName}{companyName ? ` · ${companyName}` : ""}
            </DialogDescription>
          </DialogHeader>

          {ordered.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nenhum período de acesso registrado.
            </p>
          ) : (
            <ScrollArea className="max-h-[60vh] pr-2">
              <div className="space-y-2">
                {ordered.map((p) => (
                  <div key={p.id} className="rounded-md border p-2 text-[11px] space-y-0.5">
                    <p className="font-medium text-foreground">
                      {formatAccessDate(p.period_start)} → {formatAccessDate(p.period_end)}
                    </p>
                    <div className="grid grid-cols-2 gap-x-2 text-muted-foreground">
                      <span>Meses: <span className="text-foreground">{p.months_granted ?? "—"}</span></span>
                      <span>Pago: <span className="text-foreground">{formatMoney(p.amount_paid)}</span></span>
                      <span>Forma: <span className="text-foreground">{p.payment_method || "—"}</span></span>
                      <span>Data: <span className="text-foreground">{formatDateTime(p.paid_at ?? p.created_at)}</span></span>
                    </div>
                    <p className="text-muted-foreground">
                      Liberado por:{" "}
                      <span className="text-foreground">{(p.granted_by && names[p.granted_by]) || "—"}</span>
                    </p>
                    {p.notes && <p className="text-muted-foreground">Obs.: <span className="text-foreground">{p.notes}</span></p>}
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}

          <p className="text-[10px] text-muted-foreground">Registro permanente — não editável.</p>
        </DialogContent>
      </Dialog>
    </>
  );
}
