import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Camera, Image as ImageIcon, Upload, Paperclip, X, FileText } from "lucide-react";
import { toast } from "sonner";
import EmptyState from "@/components/EmptyState";
import { ATTACHMENT_CATEGORIES, type AttachmentCategory, categoryLabel } from "@/components/ClientAttachments";

export type PendingAttachment = {
  id: string;
  file: File;
  name: string;
  category: AttachmentCategory;
  previewUrl?: string;
};

const MAX_SIZE = 10 * 1024 * 1024; // 10MB

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function PendingClientAttachments({
  items,
  onChange,
  disabled,
}: {
  items: PendingAttachment[];
  onChange: (i: PendingAttachment[]) => void;
  disabled?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const addFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const next: PendingAttachment[] = [...items];
    for (const f of Array.from(files)) {
      if (f.size > MAX_SIZE) {
        toast.error(`${f.name}: maior que 10MB`);
        continue;
      }
      next.push({
        id: crypto.randomUUID(),
        file: f,
        name: f.name,
        category: "sem_categoria",
        previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined,
      });
    }
    onChange(next);
    [fileRef, cameraRef, galleryRef].forEach((r) => { if (r.current) r.current.value = ""; });
  };

  const removeItem = (id: string) => {
    const it = items.find((x) => x.id === id);
    if (it?.previewUrl) URL.revokeObjectURL(it.previewUrl);
    onChange(items.filter((x) => x.id !== id));
  };

  const update = (id: string, patch: Partial<PendingAttachment>) => {
    onChange(items.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  };

  return (
    <div className="space-y-2 border rounded-lg p-3 bg-card">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Paperclip className="h-3.5 w-3.5" /> Documentos e imagens ({items.length})
        </h3>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Button type="button" size="sm" variant="outline" onClick={() => cameraRef.current?.click()} disabled={disabled}>
          <Camera className="mr-1 h-3.5 w-3.5" /> Câmera
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => galleryRef.current?.click()} disabled={disabled}>
          <ImageIcon className="mr-1 h-3.5 w-3.5" /> Galeria
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={disabled}>
          <Upload className="mr-1 h-3.5 w-3.5" /> Arquivo
        </Button>
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden"
          onChange={(e) => addFiles(e.target.files)} />
        <input ref={galleryRef} type="file" accept="image/*" multiple className="hidden"
          onChange={(e) => addFiles(e.target.files)} />
        <input ref={fileRef} type="file" multiple
          accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt"
          className="hidden" onChange={(e) => addFiles(e.target.files)} />
      </div>

      {items.length === 0 ? (
        <EmptyState
          compact
          icon={<Paperclip className="h-5 w-5" />}
          title="Nenhum arquivo selecionado"
          description="Os arquivos serão enviados após o cadastro do cliente."
        />
      ) : (
        <div className="space-y-2">
          {items.map((it) => (
            <div key={it.id} className="flex items-start gap-2 border rounded-md p-2">
              <div className="w-12 h-12 bg-accent rounded flex items-center justify-center overflow-hidden flex-shrink-0">
                {it.previewUrl ? (
                  <img src={it.previewUrl} alt={it.name} className="w-full h-full object-cover" />
                ) : (
                  <FileText className="h-5 w-5 text-muted-foreground" />
                )}
              </div>
              <div className="flex-1 min-w-0 space-y-1">
                <Input
                  value={it.name}
                  onChange={(e) => update(it.id, { name: e.target.value })}
                  className="h-7 text-xs"
                  disabled={disabled}
                />
                <div className="flex items-center gap-2">
                  <Select
                    value={it.category}
                    onValueChange={(v) => update(it.id, { category: v as AttachmentCategory })}
                    disabled={disabled}
                  >
                    <SelectTrigger className="h-7 text-xs flex-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ATTACHMENT_CATEGORIES.map((c) => (
                        <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Badge variant="secondary" className="text-[9px]">{fmtSize(it.file.size)}</Badge>
                </div>
                <p className="text-[9px] text-muted-foreground truncate">{categoryLabel(it.category)}</p>
              </div>
              <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => removeItem(it.id)} disabled={disabled}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
