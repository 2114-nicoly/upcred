import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { format, isToday, isYesterday, startOfWeek, startOfMonth, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/loan-utils";
import { CalendarDays, ChevronDown, ChevronUp, Wallet, MapPin, FileText, Lock, Download, Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useWorkerFilter } from "@/hooks/useWorkerFilter";
import { useMovementDays, MovementDay } from "@/hooks/useMovementDays";
import WorkerFilterSelect from "@/components/WorkerFilterSelect";
import { toast } from "sonner";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

type Filter = "all" | "today" | "yesterday" | "week" | "month" | "custom" | "closed" | "open";

function labelFor(dateStr: string) {
  const d = parseISO(dateStr + "T12:00:00");
  if (isToday(d)) return "Hoje";
  if (isYesterday(d)) return "Ontem";
  return format(d, "EEEE, dd 'de' MMM", { locale: ptBR });
}

export default function DailyCashHistoryPage() {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const { selectedWorkerId, selectedAdminId } = useWorkerFilter();
  const { days, loading } = useMovementDays({
    workerId: isAdmin ? selectedWorkerId : null,
    adminId: isAdmin && !selectedWorkerId ? selectedAdminId : null,
  });

  const [filter, setFilter] = useState<Filter>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const today = new Date();
    const todayStr = format(today, "yyyy-MM-dd");
    const yesterdayStr = format(new Date(today.getTime() - 86400000), "yyyy-MM-dd");
    const weekStart = format(startOfWeek(today, { weekStartsOn: 1 }), "yyyy-MM-dd");
    const monthStart = format(startOfMonth(today), "yyyy-MM-dd");
    return days.filter((d) => {
      switch (filter) {
        case "today": return d.date === todayStr;
        case "yesterday": return d.date === yesterdayStr;
        case "week": return d.date >= weekStart;
        case "month": return d.date >= monthStart;
        case "custom": return (!customFrom || d.date >= customFrom) && (!customTo || d.date <= customTo);
        case "closed": return d.status === "closed";
        case "open": return d.status === "open";
        default: return true;
      }
    });
  }, [days, filter, customFrom, customTo]);

  const handleDownloadDayPDF = (day: MovementDay) => {
    try {
      const doc = new jsPDF();
      doc.setFontSize(14);
      doc.text(`UpCred — Dia ${day.date}`, 14, 16);
      doc.setFontSize(10);
      doc.text(`Status: ${day.status === "closed" ? "Fechado" : day.status === "open" ? "Aberto" : "—"}`, 14, 24);
      autoTable(doc, {
        startY: 30,
        body: [
          ["Saldo inicial", formatCurrency(day.opening)],
          ["Entradas", formatCurrency(day.entradas)],
          ["Saídas", formatCurrency(day.saidas)],
          ["Saldo do dia", formatCurrency(day.saldo)],
          ["Saldo esperado", formatCurrency(day.expected)],
          ["Lançamentos", String(day.eventsCount)],
          ["Não pagou", String(day.notPaidCount)],
          ...(day.countedClosing != null ? [["Contado no caixa", formatCurrency(day.countedClosing)]] : []),
          ...(day.closingDifference != null ? [["Diferença", formatCurrency(day.closingDifference)]] : []),
        ],
        styles: { fontSize: 10 },
        theme: "plain",
      });
      doc.save(`caixa-${day.date}.pdf`);
    } catch (err) {
      toast.error("Erro ao gerar PDF");
    }
  };

  return (
    <div className="mx-auto max-w-lg p-3 space-y-3 pb-24">
      {isAdmin && (
        <Card><CardContent className="p-3"><WorkerFilterSelect /></CardContent></Card>
      )}

      <div>
        <h1 className="text-base font-semibold flex items-center gap-2">
          <CalendarDays className="h-4 w-4" /> Dias com movimento
        </h1>
        <p className="text-xs text-muted-foreground">Apenas dias com lançamentos ou caixa aberto/fechado.</p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {(["all","today","yesterday","week","month","open","closed","custom"] as Filter[]).map((f) => (
          <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} className="h-7 text-[10px]" onClick={() => setFilter(f)}>
            {{
              all: "Todos", today: "Hoje", yesterday: "Ontem", week: "Semana",
              month: "Mês", open: "Aberto", closed: "Fechado", custom: "Personalizado",
            }[f]}
          </Button>
        ))}
      </div>
      {filter === "custom" && (
        <div className="grid grid-cols-2 gap-2">
          <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="h-8 text-xs" />
          <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="h-8 text-xs" />
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-center text-muted-foreground py-10">Nenhum dia encontrado.</p>
      ) : (
        <div className="space-y-2">
          {filtered.map((day) => {
            const isExpanded = expanded === day.date;
            return (
              <Card key={day.date}>
                <button className="w-full text-left p-3" onClick={() => setExpanded(isExpanded ? null : day.date)}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold capitalize">{labelFor(day.date)}</p>
                      <p className="text-[10px] text-muted-foreground">{day.date}</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {day.status === "closed" && <Badge variant="secondary" className="text-[9px] h-4 gap-0.5"><Lock className="h-2.5 w-2.5" /> Fechado</Badge>}
                      {day.status === "open" && <Badge className="bg-success text-success-foreground text-[9px] h-4">Aberto</Badge>}
                      {isExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-1.5 text-[11px]">
                    <div className="flex justify-between"><span className="text-muted-foreground">Entradas</span><span className="text-success tabular-nums">+{formatCurrency(day.entradas)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Saídas</span><span className="text-destructive tabular-nums">-{formatCurrency(day.saidas)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Saldo</span><span className={`tabular-nums ${day.saldo >= 0 ? "text-success" : "text-destructive"}`}>{formatCurrency(day.saldo)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Lanç.</span><span className="tabular-nums">{day.eventsCount}{day.notPaidCount > 0 ? ` · ${day.notPaidCount} np` : ""}</span></div>
                  </div>
                </button>
                {isExpanded && (
                  <CardContent className="border-t pt-3 pb-3 space-y-2">
                    {day.closingDifference != null && Math.abs(day.closingDifference) > 0.01 && (
                      <div className="rounded border border-destructive/30 bg-destructive/5 p-2 text-[11px]">
                        <span className="text-muted-foreground">Diferença ao fechar: </span>
                        <span className="font-semibold text-destructive">{formatCurrency(day.closingDifference)}</span>
                      </div>
                    )}
                    <div className="grid grid-cols-4 gap-1">
                      <Button size="sm" variant="outline" className="h-7 text-[10px] px-1" onClick={() => navigate(`/?date=${day.date}`)}>
                        <MapPin className="h-3 w-3 mr-0.5" /> Rota
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 text-[10px] px-1" onClick={() => navigate(`/caixa?date=${day.date}`)}>
                        <Wallet className="h-3 w-3 mr-0.5" /> Caixa
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 text-[10px] px-1" onClick={() => navigate(`/daily-report?date=${day.date}`)}>
                        <FileText className="h-3 w-3 mr-0.5" /> Relat.
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 text-[10px] px-1" onClick={() => handleDownloadDayPDF(day)}>
                        <Download className="h-3 w-3 mr-0.5" /> PDF
                      </Button>
                    </div>
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
