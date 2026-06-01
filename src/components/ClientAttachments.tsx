import { useEffect, useState, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Paperclip, Upload, Eye, Download, Trash2, FileText, Image as ImageIcon, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { logAction } from "@/lib/audit-utils";
import { useConfirm } from "@/hooks/useConfirm";
import EmptyState from "@/components/EmptyState";

export const ATTACHMENT_CATEGORIES = [
  { value: "documento", label: "Documento" },
  { value: "comprovante", label: "Comprovante" },
  { value: "contrato", label: "Contrato" },
  { value: "foto", label: "Foto" },
  { value: "outro", label: "Outro" },
] as const;

export type AttachmentCategory = typeof ATTACHMENT_CATEGORIES[number]["value"];

export function categoryLabel(c?: string | null) {
  return ATTACHMENT_CATEGORIES.find((x) => x.value === c)?.label ?? "Outro";
}

type Attachment = {
  id: string;
  client_id: string;
  file_name: string;
  storage_path: string;
  file_type: string | null;
  file_size: number | null;
  uploaded_by: string | null;
  uploaded_at: string;
  category?: string | null;
};

const BUCKET = "client-attachments";
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

export default function ClientAttachments({ clientId, adminId }: { clientId: string; adminId: string | null }) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewIsImage, setPreviewIsImage] = useState(true);
  const [nextCategory, setNextCategory] = useState<AttachmentCategory>("documento");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();

  const fetchItems = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("client_attachments" as any)
      .select("*")
      .eq("client_id", clientId)
      .is("deleted_at", null)
      .order("uploaded_at", { ascending: false });
    if (!error) setItems((data as any) || []);
    setLoading(false);
  };

  useEffect(() => { fetchItems(); }, [clientId]);

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    let okCount = 0;
    for (const file of Array.from(files)) {
      if (file.size > MAX_SIZE) {
        toast.error(`${file.name}: arquivo maior que 10MB`);
        continue;
      }
      const folder = adminId || "shared";
      const path = `${folder}/${clientId}/${crypto.randomUUID()}-${file.name.replace(/[^\w.\-]/g, "_")}`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
        contentType: file.type || undefined,
        upsert: false,
      });
      if (upErr) {
        console.error("upload err", upErr);
        toast.error(`Falha ao enviar ${file.name}`);
        continue;
      }
      const { data: ins, error: dbErr } = await supabase
        .from("client_attachments" as any)
        .insert({
          client_id: clientId,
          file_name: file.name,
          storage_path: path,
          file_type: file.type || null,
          file_size: file.size,
          category: nextCategory,
        } as any)
        .select()
        .single();
      if (dbErr) {
        console.error(dbErr);
        await supabase.storage.from(BUCKET).remove([path]);
        toast.error(`Falha ao registrar ${file.name}`);
        continue;
      }
      okCount++;
      logAction("anexar_arquivo" as any, "client", clientId, null, { file_name: file.name, attachment_id: (ins as any)?.id, category: nextCategory });
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (okCount > 0) toast.success(`${okCount} arquivo(s) enviado(s)`);
    fetchItems();
  };

  const getSignedUrl = async (path: string) => {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60 * 5);
    if (error || !data) { toast.error("Não foi possível gerar link"); return null; }
    return data.signedUrl;
  };

  const handlePreview = async (att: Attachment) => {
    const url = await getSignedUrl(att.storage_path);
    if (!url) return;
    setPreviewIsImage((att.file_type || "").startsWith("image/"));
    setPreviewUrl(url);
  };

  const handleDownload = async (att: Attachment) => {
    const url = await getSignedUrl(att.storage_path);
    if (!url) return;
    const a = document.createElement("a");
    a.href = url; a.download = att.file_name; a.target = "_blank";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  const handleDelete = async (att: Attachment) => {
    const ok = await confirm({
      title: "Apagar anexo?",
      description: "Esta ação não pode ser desfeita.",
      affected: [
        { label: "Arquivo", value: att.file_name },
        { label: "Categoria", value: categoryLabel(att.category) },
      ],
      confirmText: "Apagar", destructive: true,
    });
    if (!ok) return;
    const { data: { session } } = await supabase.auth.getSession();
    const { error } = await supabase
      .from("client_attachments" as any)
      .update({ deleted_at: new Date().toISOString(), deleted_by: session?.user?.id ?? null } as any)
      .eq("id", att.id);
    if (error) { toast.error("Erro ao apagar"); return; }
    await supabase.storage.from(BUCKET).remove([att.storage_path]).catch(() => {});
    logAction("excluir_anexo" as any, "client", clientId, { file_name: att.file_name }, null);
    toast.success("Anexo removido");
    fetchItems();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Paperclip className="h-3.5 w-3.5" /> Anexos ({items.length})
        </h2>
        <div className="flex items-center gap-1.5">
          <Select value={nextCategory} onValueChange={(v) => setNextCategory(v as AttachmentCategory)}>
            <SelectTrigger className="h-8 w-[130px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ATTACHMENT_CATEGORIES.map((c) => (
                <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1 h-3.5 w-3.5" />}
            Anexar
          </Button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,application/pdf"
          className="hidden"
          onChange={(e) => handleUpload(e.target.files)}
        />
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Carregando...</p>
      ) : items.length === 0 ? (
        <EmptyState
          compact
          icon={<Paperclip className="h-5 w-5" />}
          title="Nenhum anexo"
          description="Escolha uma categoria e toque em Anexar para enviar imagens ou PDFs."
        />
      ) : (
        <div className="space-y-1.5">
          {items.map((att) => {
            const isImg = (att.file_type || "").startsWith("image/");
            return (
              <Card key={att.id}>
                <CardContent className="flex items-center gap-2 p-2">
                  <div className="h-10 w-10 flex items-center justify-center rounded bg-accent shrink-0">
                    {isImg ? <ImageIcon className="h-5 w-5 text-primary" /> : <FileText className="h-5 w-5 text-muted-foreground" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate">{att.file_name}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <Badge variant="secondary" className="text-[9px] h-4 px-1.5">{categoryLabel(att.category)}</Badge>
                      <p className="text-[10px] text-muted-foreground">
                        {format(new Date(att.uploaded_at), "dd/MM/yyyy HH:mm")}
                        {att.file_size ? ` • ${(att.file_size / 1024).toFixed(0)} KB` : ""}
                      </p>
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => handlePreview(att)}><Eye className="h-3.5 w-3.5" /></Button>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => handleDownload(att)}><Download className="h-3.5 w-3.5" /></Button>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => handleDelete(att)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={!!previewUrl} onOpenChange={(o) => { if (!o) setPreviewUrl(null); }}>
        <DialogContent className="max-w-3xl">
          {previewUrl && (
            previewIsImage ? (
              <img src={previewUrl} alt="anexo" className="max-h-[80vh] mx-auto rounded" />
            ) : (
              <iframe src={previewUrl} className="w-full h-[80vh] rounded" title="anexo" />
            )
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
