import { supabase } from "@/integrations/supabase/client";
import { logAction } from "@/lib/audit-utils";
import type { PendingAttachment } from "@/components/PendingClientAttachments";

const BUCKET = "client-attachments";

export type UploadResult = {
  ok: PendingAttachment[];
  failed: { item: PendingAttachment; reason: string }[];
};

export async function uploadPendingAttachments(
  clientId: string,
  items: PendingAttachment[],
): Promise<UploadResult> {
  const result: UploadResult = { ok: [], failed: [] };
  if (items.length === 0) return result;

  const { data: clientRow, error: clientErr } = await supabase
    .from("clients")
    .select("admin_id")
    .eq("id", clientId)
    .maybeSingle();
  if (clientErr || !clientRow?.admin_id) {
    for (const it of items) result.failed.push({ item: it, reason: "admin_id não encontrado" });
    return result;
  }
  const tenantFolder = String((clientRow as any).admin_id);

  for (const it of items) {
    const safeName = (it.file.name || `arquivo-${Date.now()}`).replace(/[^\w.\-]/g, "_");
    const path = `${tenantFolder}/${clientId}/${crypto.randomUUID()}-${safeName}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, it.file, {
      contentType: it.file.type || undefined,
      upsert: false,
    });
    if (upErr) {
      result.failed.push({ item: it, reason: upErr.message || "Falha ao enviar" });
      continue;
    }
    const categoryToStore = it.category === "sem_categoria" ? null : it.category;
    const { data: ins, error: dbErr } = await supabase
      .from("client_attachments" as any)
      .insert({
        client_id: clientId,
        file_name: it.name || safeName,
        storage_path: path,
        file_type: it.file.type || null,
        file_size: it.file.size,
        category: categoryToStore,
      } as any)
      .select()
      .single();
    if (dbErr) {
      await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
      result.failed.push({ item: it, reason: dbErr.message || "Falha ao registrar" });
      continue;
    }
    result.ok.push(it);
    logAction("anexar_arquivo" as any, "client", clientId, null, {
      file_name: it.name, attachment_id: (ins as any)?.id, category: categoryToStore,
    });
  }
  return result;
}
