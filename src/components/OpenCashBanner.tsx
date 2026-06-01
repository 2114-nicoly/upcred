import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Unlock, AlertTriangle } from "lucide-react";
import { useState } from "react";
import { openDailyCash } from "@/lib/cash-lock";
import { toast } from "sonner";

type Props = {
  cashDate: string;
  onOpened?: () => void;
  disabled?: boolean;
  compact?: boolean;
};

/**
 * Banner shown when the day has no daily_cash row yet (neutral state).
 * Renders the "Abrir Caixa do Dia" CTA which calls open_daily_cash RPC.
 */
export default function OpenCashBanner({ cashDate, onOpened, disabled, compact }: Props) {
  const [loading, setLoading] = useState(false);

  const handleOpen = async () => {
    if (loading) return;
    setLoading(true);
    try {
      await openDailyCash(cashDate);
      toast.success("Caixa do dia aberto!");
      onOpened?.();
    } catch (err: any) {
      console.error("[OpenCashBanner] open failed", err);
      toast.error(err?.message || "Erro ao abrir caixa do dia");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="border-warning/40 bg-warning/5">
      <CardContent className={compact ? "p-3 space-y-2" : "p-4 space-y-3"}>
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
