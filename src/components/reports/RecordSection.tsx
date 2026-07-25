import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { formatCurrency } from "@/lib/loan-utils";
import type { ReportRecord } from "@/lib/report-details";

/**
 * Seção recolhível de registros detalhados (apresentação apenas).
 * Resumo na lista; ao abrir o registro, mostra todos os detalhes disponíveis.
 */
export function RecordSection({
  title,
  records,
  hideWhenEmpty = true,
  showWorker = false,
}: {
  title: string;
  records: ReportRecord[];
  hideWhenEmpty?: boolean;
  showWorker?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (hideWhenEmpty && records.length === 0) return null;
  const total = records.reduce((s, r) => s + r.amountIn + r.amountOut, 0);

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="w-full" disabled={records.length === 0}>
          <div className="flex items-center justify-between gap-2 p-3">
            <div className="flex items-center gap-2 min-w-0">
              <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""} ${records.length === 0 ? "opacity-30" : ""}`} />
              <span className="text-sm font-medium truncate">{title}</span>
              <Badge variant="outline" className="h-5 text-[10px] shrink-0">{records.length}</Badge>
            </div>
            {total > 0 && (
              <span className="text-xs font-semibold tabular-nums shrink-0">{formatCurrency(total)}</span>
            )}
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="divide-y border-t">
            {records.map((r) => (
              <RecordRow key={r.id} record={r} showWorker={showWorker} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

export function RecordRow({ record, showWorker }: { record: ReportRecord; showWorker?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full text-left">
        <div className="flex items-start justify-between gap-2 p-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] text-muted-foreground tabular-nums">{record.time}</span>
              <span className="text-sm font-medium truncate">{record.clientName}</span>
              <Badge variant="outline" className="text-[10px] h-4 shrink-0">{record.title}</Badge>
              {record.reversed && <Badge variant="outline" className="text-[10px] h-4 shrink-0">Estornado</Badge>}
            </div>
            <p className="text-[11px] text-muted-foreground break-words mt-0.5">{record.summary}</p>
            {showWorker && record.workerName !== "—" && (
              <p className="text-[10px] text-muted-foreground mt-0.5">Trabalhador: {record.workerName}</p>
            )}
          </div>
          <div className="text-right shrink-0 flex items-start gap-1">
            <div>
              {record.amountIn > 0 && <p className="text-success text-xs font-semibold">+ {formatCurrency(record.amountIn)}</p>}
              {record.amountOut > 0 && <p className="text-destructive text-xs font-semibold">- {formatCurrency(record.amountOut)}</p>}
            </div>
            <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-3 pb-3">
          <Card className="bg-muted/40 border-none shadow-none">
            <CardContent className="p-2.5">
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1">
                {record.details.map((d, idx) => (
                  <div key={idx} className="flex justify-between gap-2 text-[11px]">
                    <dt className="text-muted-foreground shrink-0">{d.label}</dt>
                    <dd className="font-medium text-right break-words">{d.value}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Linhas de detalhe formatadas para o PDF (mesmos dados da tela). */
export function recordPdfLines(record: ReportRecord): string[] {
  return record.details.map((d) => `${d.label}: ${d.value}`);
}
