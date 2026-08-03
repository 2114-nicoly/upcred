import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CalendarClock, ArrowLeftRight } from "lucide-react";
import { openCashNoticeMessage } from "@/lib/active-cash";

type Props = {
  activeCashDate: string;
  currentDate: string;
  onBack?: () => void;
};

/**
 * Aviso do caixa operacional ativo. Quando o usuário está consultando outra
 * data, oferece o retorno ao caixa aberto (as ações ficam bloqueadas).
 */
export default function ActiveCashNotice({ activeCashDate, currentDate, onBack }: Props) {
  const viewingOther = currentDate !== activeCashDate;
  return (
    <Card className="border-warning/40 bg-warning/5">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start gap-2">
          <CalendarClock className="h-4 w-4 text-warning shrink-0 mt-0.5" />
          <p className="text-[11px] font-medium leading-snug">
            {openCashNoticeMessage(activeCashDate)}
          </p>
        </div>
        {viewingOther && (
          <Button size="sm" variant="outline" className="w-full h-8 text-xs" onClick={onBack}>
            <ArrowLeftRight className="mr-1.5 h-3.5 w-3.5" />
            Voltar ao caixa aberto
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
