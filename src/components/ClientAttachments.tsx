import { useEffect, useState, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Paperclip, Upload, Camera, Image as ImageIcon, FileText, Loader2, MoreVertical,
  Eye, Download, Share2, Tag, Pencil, Archive, RotateCcw,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { logAction } from "@/lib/audit-utils";
import { useConfirm } from "@/hooks/useConfirm";
import EmptyState from "@/components/EmptyState";

export const ATTACHMENT_CATEGORIES = [
  { value: "sem_categoria", label: "Sem categoria" },
  { value: "rg", label: "RG" },
  { value: "cpf", label: "CPF" },
  { value: "cnh", label: "CNH" },
  { value: "comprovante_residencia", label: "Comprovante de residência" },
  { value: "comprovante_renda", label: "Comprovante de renda" },
  { value: "contrato", label: "Contrato" },
  { value: "foto_cliente", label: "Foto do cliente" },
  { value: "garantia", label: "Garantia" },
  { value: "outro", label: "Outro" },
] as const;

export type AttachmentCategory = typeof ATTACHMENT_CATEGORIES[number]["value"];

export function categoryLabel(c?: string | null) {
  if (!c) return "Sem categoria";
  return ATTACHMENT_CATEGORIES.find((x) => x.value === c)?.label ?? "Sem categoria";
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
  deleted_at?: string | null;
};

const BUCKET = "client-attachments";
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

export default function ClientAttachments({ clientId }: { clientId: string; adminId?: string | null }) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ url: string; isImage: boolean; name: string } | null>(null);
  const [renaming, setRenaming] = useState<Attachment | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [changingCat, setChangingCat] = useState<Attachment | null>(null);
  const [newCategory, setNewCategory] = useState<AttachmentCategory>("sem_categoria");

  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();

  const fetchItems = async () => {
    setLoading(true);
    const q = supabase
      .from("client_attachments" as any)
      .select("*")
      .eq("client_id", clientId)
      .order("uploaded_at", { ascending: false });
    if (!showArchived) q.is("deleted_at", null);
    const { data, error } = await q;
    if (!error) setItems(((data as any) || []) as Attachment[]);
    setLoading(false);
  };

  useEffect(() => { fetchItems(); /* eslint-disable-next-line */ }, [clientId, showArchived]);

  // Generate signed URLs for image thumbnails
  useEffect(() => {
    let cancelled = false;
    const missing = items.filter((a) => (a.file_type || "").startsWith("image/") && !thumbs[a.id]);
    if (missing.length === 0) return;
    (async () => {
      const updates: Record<string, string> = {};
      for (const a of missing) {
        const { data } = await supabase.storage.from(BUCKET).createSignedUrl(a.storage_path, 60 * 10);
        if (data?.signedUrl) updates[a.id] = data.signedUrl;
      }
      if (!cancelled && Object.keys(updates).length) setThumbs((prev) => ({ ...prev, ...updates }));
    })();
    return () => { cancelled = true; };
  }, [items]);

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    const { data: clientRow, error: clientErr } = await supabase
      .from("clients")
      .select("admin_id")
      .eq("id", clientId)
      .maybeSingle();
    if (clientErr || !clientRow?.admin_id) {
      setUploading(false);
      toast.error("Não foi possível identificar o administrador do cliente");
      return;
    }
    const tenantFolder = String((clientRow as any).admin_id);
    let okCount = 0;
    for (const file of Array.from(files)) {
      if (file.size > MAX_SIZE) {
        toast.error(`${file.name}: arquivo maior que 10MB`);
        continue;
      }
      const safeName = (file.name || `arquivo-${Date.now()}`).replace(/[^\w.\-]/g, "_");
      const path = `${tenantFolder}/${clientId}/${crypto.randomUUID()}-${safeName}`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
        contentType: file.type || undefined,
        upsert: false,
      });
      if (upErr) { toast.error(`Falha ao enviar ${file.name}`); continue; }
      const { data: ins, error: dbErr } = await supabase
        .from("client_attachments" as any)
        .insert({
          client_id: clientId,
          file_name: file.name || safeName,
          storage_path: path,
          file_type: file.type || null,
          file_size: file.size,
          category: null,
        } as any)
        .select()
        .single();
      if (dbErr) {
        await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
        toast.error(`Falha ao registrar ${file.name}`);
        continue;
      }
      okCount++;
      logAction("anexar_arquivo" as any, "client", clientId, null, {
        file_name: file.name, attachment_id: (ins as any)?.id, category: null,
      });
    }
    setUploading(false);
    [fileRef, cameraRef, galleryRef].forEach((r) => { if (r.current) r.current.value = ""; });
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
    setPreview({ url, isImage: (att.file_type || "").startsWith("image/"), name: att.file_name });
  };

  const handleDownload = async (att: Attachment) => {
    const url = await getSignedUrl(att.storage_path);
    if (!url) return;
    const a = document.createElement("a");
    a.href = url; a.download = att.file_name; a.target = "_blank";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    logAction("baixar_anexo" as any, "client", clientId, null, { attachment_id: att.id, file_name: att.file_name });
  };

  const handleShare = async (att: Attachment) => {
    const url = await getSignedUrl(att.storage_path);
    if (!url) return;
    try {
      if ((navigator as any).share) {
        await (navigator as any).share({ title: att.file_name, url });
      } else {
        await navigator.clipboard.writeText(url);
        toast.success("Link copiado para a área de transferência");
      }
    } catch { /* user cancelled */ }
  };

  const handleArchive = async (att: Attachment) => {
    const ok = await confirm({
      title: "Arquivar anexo?",
      description: "Você poderá restaurar depois em 'Mostrar arquivados'.",
      affected: [{ label: "Arquivo", value: att.file_name }],
      confirmText: "Arquivar",
    });
    if (!ok) return;
    const { data: { session } } = await supabase.auth.getSession();
    const { error } = await supabase
      .from("client_attachments" as any)
      .update({ deleted_at: new Date().toISOString(), deleted_by: session?.user?.id ?? null } as any)
      .eq("id", att.id);
    if (error) { toast.error("Erro ao arquivar"); return; }
    logAction("arquivar_anexo" as any, "client", clientId, { file_name: att.file_name }, null);
    toast.success("Anexo arquivado");
    fetchItems();
  };

  const handleRestore = async (att: Attachment) => {
    const { error } = await supabase
      .from("client_attachments" as any)
      .update({ deleted_at: null, deleted_by: null } as any)
      .eq("id", att.id);
    if (error) { toast.error("Erro ao restaurar"); return; }
    logAction("restaurar_anexo" as any, "client", clientId, null, { file_name: att.file_name });
    toast.success("Anexo restaurado");
    fetchItems();
  };

  const openRename = (att: Attachment) => { setRenaming(att); setRenameValue(att.file_name); };
  const submitRename = async () => {
    if (!renaming) return;
    const newName = renameValue.trim();
    if (!newName) { toast.error("Informe um nome"); return; }
    const { error } = await supabase
      .from("client_attachments" as any)
      .update({ file_name: newName } as any)
      .eq("id", renaming.id);
    if (error) { toast.error("Erro ao renomear"); return; }
    logAction("renomear_anexo" as any, "client", clientId,
      { file_name: renaming.file_name }, { file_name: newName });
    toast.success("Renomeado");
    setRenaming(null);
    fetchItems();
  };

  const openChangeCategory = (att: Attachment) => {
    setChangingCat(att);
    setNewCategory((att.category as AttachmentCategory) || "sem_categoria");
  };
  const submitChangeCategory = async () => {
    if (!changingCat) return;
    const valueToStore = newCategory === "sem_categoria" ? null : newCategory;
    const { error } = await supabase
      .from("client_attachments" as any)
      .update({ category: valueToStore } as any)
      .eq("id", changingCat.id);
    if (error) { toast.error("Erro ao alterar categoria"); return; }
    logAction("categoria_anexo" as any, "client", clientId,
      { category: changingCat.category }, { category: valueToStore });
    toast.success("Categoria atualizada");
    setChangingCat(null);
    fetchItems();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Paperclip className="h-3.5 w-3.5" /> Documentos e imagens ({items.length})
        </h2>
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Switch checked={showArchived} onCheckedChange={setShowArchived} />
            <span>Arquivados</span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" onClick={() => cameraRef.current?.click()} disabled={uploading}>
          <Camera className="mr-1 h-3.5 w-3.5" /> Câmera
        </Button>
        <Button size="sm" variant="outline" onClick={() => galleryRef.current?.click()} disabled={uploading}>
          <ImageIcon className="mr-1 h-3.5 w-3.5" /> Galeria
        </Button>
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1 h-3.5 w-3.5" />}
          Arquivo
        </Button>
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden"
          onChange={(e) => handleUpload(e.target.files)} />
        <input ref={galleryRef} type="file" accept="image/*" multiple className="hidden"
          onChange={(e) => handleUpload(e.target.files)} />
        <input ref={fileRef} type="file" multiple
          accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt"
          className="hidden" onChange={(e) => handleUpload(e.target.files)} />
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Carregando...</p>
      ) : items.length === 0 ? (
        <EmptyState
          compact
          icon={<Paperclip className="h-5 w-5" />}
          title={showArchived ? "Nenhum arquivado" : "Nenhum documento"}
          description={showArchived ? "Nada arquivado até o momento." : "Use a câmera, a galeria ou anexe um arquivo."}
        />
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {items.map((att) => {
            const isImg = (att.file_type || "").startsWith("image/");
            const archived = !!att.deleted_at;
            return (
              <div key={att.id} className={`relative rounded-lg overflow-hidden border bg-card ${archived ? "opacity-60" : ""}`}>
                <button
                  className="block w-full aspect-square bg-accent flex items-center justify-center"
                  onClick={() => handlePreview(att)}
                  aria-label={`Visualizar ${att.file_name}`}
                >
                  {isImg && thumbs[att.id] ? (
                    <img src={thumbs[att.id]} alt={att.file_name} className="w-full h-full object-cover" />
                  ) : isImg ? (
                    <ImageIcon className="h-6 w-6 text-primary" />
                  ) : (
                    <FileText className="h-6 w-6 text-muted-foreground" />
                  )}
                </button>
                <div className="absolute top-1 right-1">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="secondary" className="h-6 w-6 p-0 bg-background/80 backdrop-blur">
                        <MoreVertical className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownMenuItem onClick={() => handlePreview(att)}>
                        <Eye className="mr-2 h-3.5 w-3.5" /> Visualizar
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleDownload(att)}>
                        <Download className="mr-2 h-3.5 w-3.5" /> Baixar
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleShare(att)}>
                        <Share2 className="mr-2 h-3.5 w-3.5" /> Compartilhar
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => openChangeCategory(att)}>
                        <Tag className="mr-2 h-3.5 w-3.5" /> Alterar categoria
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => openRename(att)}>
                        <Pencil className="mr-2 h-3.5 w-3.5" /> Renomear
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      {archived ? (
                        <DropdownMenuItem onClick={() => handleRestore(att)}>
                          <RotateCcw className="mr-2 h-3.5 w-3.5" /> Restaurar
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onClick={() => handleArchive(att)} className="text-destructive focus:text-destructive">
                          <Archive className="mr-2 h-3.5 w-3.5" /> Arquivar
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="p-1.5 space-y-0.5">
                  <p className="text-[10px] font-medium truncate" title={att.file_name}>{att.file_name}</p>
                  <div className="flex items-center gap-1">
                    <Badge variant="secondary" className="text-[8px] h-3.5 px-1 leading-none">
                      {categoryLabel(att.category)}
                    </Badge>
                    {archived && <Badge variant="outline" className="text-[8px] h-3.5 px-1 leading-none">Arquivado</Badge>}
                  </div>
                  <p className="text-[9px] text-muted-foreground">
                    {format(new Date(att.uploaded_at), "dd/MM/yy HH:mm")}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Preview */}
      <Dialog open={!!preview} onOpenChange={(o) => { if (!o) setPreview(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle className="text-sm truncate">{preview?.name}</DialogTitle></DialogHeader>
          {preview && (
            preview.isImage ? (
              <img src={preview.url} alt={preview.name} className="max-h-[80vh] mx-auto rounded" />
            ) : (
              <iframe src={preview.url} className="w-full h-[80vh] rounded" title={preview.name} />
            )
          )}
        </DialogContent>
      </Dialog>

      {/* Rename */}
      <Dialog open={!!renaming} onOpenChange={(o) => { if (!o) setRenaming(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Renomear anexo</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <Label>Novo nome</Label>
            <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>Cancelar</Button>
            <Button onClick={submitRename}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change category */}
      <Dialog open={!!changingCat} onOpenChange={(o) => { if (!o) setChangingCat(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Alterar categoria</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <Label>Categoria</Label>
            <Select value={newCategory} onValueChange={(v) => setNewCategory(v as AttachmentCategory)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ATTACHMENT_CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setChangingCat(null)}>Cancelar</Button>
            <Button onClick={submitChangeCategory}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
