import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";

/**
 * Padrão único de PDF dos relatórios (Trabalhador e Administrador).
 * Nenhum cálculo aqui — apenas layout/estrutura visual compartilhada.
 */
export type ReportPdfBuilder = {
  doc: jsPDF;
  pageWidth: number;
  pageHeight: number;
  cursorY: () => number;
  ensureSpace: (needed: number) => void;
  blockTitle: (title: string) => void;
  text: (text: string, size?: number) => void;
  table: (
    title: string | null,
    head: string[],
    body: (string | number)[][],
    opts?: { rightCols?: number[] },
  ) => void;
};

export function createReportPdf(opts: {
  title: string;
  metaLines: string[];
}): ReportPdfBuilder {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const issuedAt = format(new Date(), "dd/MM/yyyy HH:mm", { locale: ptBR });

  const lines = opts.metaLines.filter(Boolean);
  const HEADER_BOTTOM = 24 + lines.length * 6 + 6;
  const PAGE_BOTTOM = pageHeight - 16;

  const drawHeader = () => {
    doc.setFontSize(15);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0, 0, 0);
    doc.text(opts.title, 14, 16);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(`Emitido em ${issuedAt}`, pageWidth - 14, 16, { align: "right" });
    doc.setFontSize(10);
    lines.forEach((l, i) => doc.text(l, 14, 24 + i * 6));
    doc.setDrawColor(200);
    doc.line(14, HEADER_BOTTOM - 4, pageWidth - 14, HEADER_BOTTOM - 4);
  };

  drawHeader();
  (doc as any).lastAutoTable = { finalY: HEADER_BOTTOM };

  const cursorY = () => (doc as any).lastAutoTable?.finalY ?? HEADER_BOTTOM;

  const ensureSpace = (needed: number) => {
    if (cursorY() + needed > PAGE_BOTTOM) {
      doc.addPage();
      drawHeader();
      (doc as any).lastAutoTable = { finalY: HEADER_BOTTOM };
    }
  };

  const blockTitle = (title: string) => {
    ensureSpace(16);
    const y = cursorY() + 9;
    doc.setFillColor(59, 130, 246);
    doc.rect(14, y - 5, pageWidth - 28, 8, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text(title, 16, y);
    doc.setTextColor(0, 0, 0);
    doc.setFont("helvetica", "normal");
    (doc as any).lastAutoTable = { finalY: y + 3 };
  };

  const text = (t: string, size = 9) => {
    ensureSpace(10);
    const y = cursorY() + 6;
    doc.setFontSize(size);
    doc.text(t, 14, y);
    (doc as any).lastAutoTable = { finalY: y };
  };

  const table: ReportPdfBuilder["table"] = (title, head, body, tOpts = {}) => {
    if (body.length === 0) return;
    ensureSpace(22);
    let startY = cursorY() + 6;
    if (title) {
      doc.setFontSize(10);
      doc.setFont("helvetica", "bold");
      doc.text(title, 14, startY);
      doc.setFont("helvetica", "normal");
      startY += 2;
    }
    const columnStyles: any = {};
    (tOpts.rightCols || []).forEach((c) => { columnStyles[c] = { halign: "right" }; });
    autoTable(doc, {
      startY,
      head: [head],
      body,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [59, 130, 246] },
      columnStyles,
      margin: { top: HEADER_BOTTOM, left: 14, right: 14, bottom: 16 },
      didDrawPage: () => drawHeader(),
    });
  };

  return { doc, pageWidth, pageHeight, cursorY, ensureSpace, blockTitle, text, table };
}

/** Download padrão (mesma lógica usada pelo Relatório do Trabalhador). */
export function downloadReportPdf(doc: jsPDF, filename: string) {
  doc.save(filename);
  toast.success("PDF gerado");
}

/** Compartilhamento padrão — usa exatamente o PDF gerado. */
export async function shareReportPdf(doc: jsPDF, filename: string, shareText: string) {
  const blob = doc.output("blob");
  const file = new File([blob], filename, { type: "application/pdf" });
  const nav: any = navigator;
  if (nav.canShare && nav.canShare({ files: [file] })) {
    await nav.share({ files: [file], title: filename, text: shareText });
  } else {
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    toast.message("Compartilhamento direto indisponível — abri o PDF para você salvar/enviar.");
  }
}
