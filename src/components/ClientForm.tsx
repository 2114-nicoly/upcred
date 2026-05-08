import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";

export type ClientFormValues = {
  name: string;
  full_name: string;
  phone: string;
  address: string;
  doc_primary_type: "CPF" | "RG" | "";
  doc_primary_number: string;
  doc_secondary_type: "CPF" | "RG" | "";
  doc_secondary_number: string;
  notes: string;
};

export const emptyClientForm: ClientFormValues = {
  name: "", full_name: "", phone: "", address: "",
  doc_primary_type: "CPF", doc_primary_number: "",
  doc_secondary_type: "", doc_secondary_number: "",
  notes: "",
};

export function validateClientForm(v: ClientFormValues): string | null {
  if (!v.name.trim()) return "Nome principal é obrigatório";
  if (!v.full_name.trim()) return "Nome completo é obrigatório";
  if (!v.phone.trim()) return "Telefone é obrigatório";
  if (!v.address.trim()) return "Endereço é obrigatório";
  if (!v.doc_primary_type) return "Tipo do documento principal é obrigatório";
  if (!v.doc_primary_number.trim()) return "Número do documento principal é obrigatório";
  if (v.doc_secondary_number.trim() && !v.doc_secondary_type) return "Selecione o tipo do documento secundário";
  return null;
}

export default function ClientForm({
  value,
  onChange,
  extra,
  submitLabel,
  onSubmit,
}: {
  value: ClientFormValues;
  onChange: (v: ClientFormValues) => void;
  extra?: React.ReactNode;
  submitLabel: string;
  onSubmit: () => void;
}) {
  const set = <K extends keyof ClientFormValues>(k: K, val: ClientFormValues[K]) => onChange({ ...value, [k]: val });

  return (
    <div className="space-y-3">
      <div>
        <Label>Nome principal *</Label>
        <Input value={value.name} onChange={(e) => set("name", e.target.value)} placeholder="Como aparece nas listas" />
      </div>
      <div>
        <Label>Nome completo *</Label>
        <Input value={value.full_name} onChange={(e) => set("full_name", e.target.value)} placeholder="Nome completo do cliente" />
      </div>
      <div>
        <Label>Telefone *</Label>
        <Input value={value.phone} onChange={(e) => set("phone", e.target.value)} placeholder="(00) 00000-0000" />
      </div>
      <div>
        <Label>Endereço *</Label>
        <Textarea value={value.address} onChange={(e) => set("address", e.target.value)} placeholder="Rua, número, bairro, cidade" rows={2} />
      </div>

      <div className="border-t pt-2">
        <p className="text-xs font-semibold text-muted-foreground mb-2">Documento principal *</p>
        <div className="grid grid-cols-3 gap-2">
          <Select value={value.doc_primary_type} onValueChange={(v) => set("doc_primary_type", v as any)}>
            <SelectTrigger><SelectValue placeholder="Tipo" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="CPF">CPF</SelectItem>
              <SelectItem value="RG">RG</SelectItem>
            </SelectContent>
          </Select>
          <Input className="col-span-2" value={value.doc_primary_number} onChange={(e) => set("doc_primary_number", e.target.value)} placeholder="Número" />
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-muted-foreground mb-2">Documento secundário (opcional)</p>
        <div className="grid grid-cols-3 gap-2">
          <Select value={value.doc_secondary_type || "__none"} onValueChange={(v) => set("doc_secondary_type", (v === "__none" ? "" : v) as any)}>
            <SelectTrigger><SelectValue placeholder="Tipo" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">—</SelectItem>
              <SelectItem value="CPF">CPF</SelectItem>
              <SelectItem value="RG">RG</SelectItem>
            </SelectContent>
          </Select>
          <Input className="col-span-2" value={value.doc_secondary_number} onChange={(e) => set("doc_secondary_number", e.target.value)} placeholder="Número" />
        </div>
      </div>

      <div>
        <Label>Observações</Label>
        <Textarea value={value.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Observações gerais" rows={2} />
      </div>

      {extra}

      <Button onClick={onSubmit} className="w-full">{submitLabel}</Button>
    </div>
  );
}
