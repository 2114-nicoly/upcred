import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Unlock, AlertTriangle, CalendarClock, Lock } from "lucide-react";
import { useState } from "react";
import { openDailyCash, classifyCashDate } from "@/lib/cash-lock";
import { formatCashDate, openCashNoticeMessage } from "@/lib/active-cash";
import { toast } from "sonner";

type Props = {
  cashDate: string;
  workerId?: string | null;
  onOpened?: () => void;
  disabled?: boolean;
  compact?: boolean;
  /** Data do caixa aberto do escopo — impede abrir outro caixa. */
  activeCashDate?: string | null;
  /** Data passada sem daily_cash: abre o fluxo de solicitação de reabertura. */
  onRequestMissedOpen?: () => void;
  /** Já existe solicitação pendente para essa data. */
  missedRequestPending?: boolean;
};

/**
 * Banner shown when the day has no daily_cash row yet (neutral state).
 * Opening is only allowed on the current date (America/Sao_Paulo) and only
 * when there is no other cash already open for the scope.
 */
export default function OpenCashBanner({ cashDate, workerId, onOpened, disabled, compact, activeCashDate, onRequestMissedOpen, missedRequestPending }: Props) {
  const [loading, setLoading] = useState(false);
  const kind = classifyCashDate(cashDate);
  const padding = compact ? "p-3 space-y-2" : "p-4 space-y-3";
  const blockedByOpenCash = !!activeCashDate && activeCashDate !== cashDate;

  const handleOpen = async () => {
    if (loading || kind !== "today" || blockedByOpenCash) return;
    setLoading(true);
    try {
      await openDailyCash(cashDate, workerId ?? undefined);
      toast.success("Caixa do dia aberto!");
      onOpened?.();
    } catch (err: any) {
      console.error("[OpenCashBanner] open failed", err);
      toast.error(err?.message || "Erro ao abrir caixa do dia");
    } finally {
      setLoading(false);
    }
  };

  if (blockedByOpenCash) {
    return (
      <Card className="border-warning/40 bg-warning/5">
        <CardContent className={padding}>
          <div className="flex items-start gap-2">
            <CalendarClock className="h-4 w-4 text-warning shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold">Já existe um caixa aberto</p>
              <p className="text-[11px] text-muted-foreground">
                {openCashNoticeMessage(activeCashDate!)} Feche o caixa de {formatCashDate(activeCashDate!)} antes de abrir outro.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }


  if (kind === "past") {
    return (
      <Card className="border-muted-foreground/30 bg-muted/40">
        <CardContent className={padding}>
          <div className="flex items-start gap-2">
            <Lock className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold">Caixa não foi aberto nesta data</p>
              <p className="text-[11px] text-muted-foreground">
                Não é permitido abrir um caixa antigo. Utilize o processo de solicitação de reabertura.
                Você ainda pode visualizar os dados deste dia.
              </p>
            </div>
          </div>
          {missedRequestPending ? (
            <p className="text-[11px] text-warning font-medium text-center">
              Reabertura solicitada — aguardando aprovação
            </p>
          ) : onRequestMissedOpen ? (
            <Button
              onClick={onRequestMissedOpen}
              disabled={disabled}
              variant="outline"
              className="w-full text-xs h-9 border-warning/40 text-warning"
            >
              <Unlock className="mr-1.5 h-3.5 w-3.5" />
              Solicitar reabertura
            </Button>
          ) : null}
        </CardContent>
      </Card>

    );
  }

  if (kind === "future") {
    return (
      <Card className="border-muted-foreground/30 bg-muted/40">
        <CardContent className={padding}>
          <div className="flex items-start gap-2">
            <CalendarClock className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold">O caixa só poderá ser aberto na própria data</p>
              <p className="text-[11px] text-muted-foreground">
                Não é permitido abrir caixa em data futura. Você ainda pode navegar e visualizar.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-warning/40 bg-warning/5">
      <CardContent className={padding}>
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold">Caixa do dia ainda não iniciado</p>
            <p className="text-[11px] text-muted-foreground">
              Abra o caixa para registrar pagamentos, empréstimos, entradas e saídas deste dia.
              Você ainda pode navegar e visualizar dados.
            </p>
          </div>
        </div>
        <Button
          onClick={handleOpen}
          disabled={disabled || loading}
          className="w-full bg-warning text-warning-foreground hover:bg-warning/90 h-9 text-xs"
        >
          <Unlock className="mr-1.5 h-3.5 w-3.5" />
          {loading ? "Abrindo..." : "Abrir Caixa do Dia"}
        </Button>
      </CardContent>
    </Card>
  );
}

