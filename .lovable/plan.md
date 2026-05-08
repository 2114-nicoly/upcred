## Plano: Cadastro de Cliente Completo, Anexos, Observações e Histórico

Vou implementar em 4 fases. Confirma e eu executo tudo em sequência.

---

### Fase 1 — Banco de dados (migração)

**Tabela `clients` — novos campos:**
- `full_name` text (nome completo, obrigatório a partir de agora via validação no app)
- `address` text (endereço, obrigatório no app)
- `doc_primary_type` text ('CPF' ou 'RG')
- `doc_primary_number` text
- `doc_secondary_type` text (opcional)
- `doc_secondary_number` text (opcional)
- `phone` continua existindo (passa a ser obrigatório no app)

**Tabela `loans` — novo campo:**
- `observation` text (observação editável)

**Nova tabela `client_attachments`:**
- `id`, `client_id`, `admin_id`, `worker_id`
- `file_name`, `storage_path`, `file_type`, `file_size`
- `uploaded_by`, `uploaded_at`
- `deleted_at`, `deleted_by` (exclusão lógica)
- RLS: mesma regra de `clients` (super_admin / admin do time / worker dono)

**Bucket de Storage `client-attachments`:**
- Privado (não público)
- Policies por `admin_id` no path (`{admin_id}/{client_id}/{uuid}-{filename}`)
- URLs assinadas para visualização/download

**Auditoria:**
- Reaproveitar `log_audit` já existente
- Novas ações: `editar_observacao_emprestimo`, `anexar_arquivo`, `excluir_anexo`
- Já cobertas: `editar_cliente`, `criar_cliente`, etc.

---

### Fase 2 — Cadastro e detalhe do cliente

**Formulário de criação (`ClientsPage` modal "Novo cliente" e inline em NewLoan):**
- Campos obrigatórios: nome principal, nome completo, telefone, endereço, doc principal (tipo + número)
- Opcionais: doc secundário, observações
- Validação com Zod
- Mantém a lógica `admin_create_client` mas estende para passar os novos campos (vou adaptar a função SQL para receber os campos extras)

**Detalhe do cliente (`ClientDetailPage`) — reorganizar em seções:**
1. Dados principais (nome, nome completo)
2. Documentos (principal + secundário se houver)
3. Endereço e contato (telefone + endereço)
4. Empréstimo ativo (já existe)
5. Histórico de empréstimos (já existe)
6. **Anexos** (nova seção)
7. **Histórico de alterações** (nova seção, lê de `audit_logs` filtrado por `entity='client'` e `entity_id=clientId`)

**Edição:** dialog ampliado com todos os campos novos. Cada save chama `log_audit` com old/new value.

---

### Fase 3 — Anexos (Storage)

**Componente `ClientAttachments`:**
- Upload (input file múltiplo, aceita imagens e PDFs, limite 10MB cada)
- Lista com miniatura (para imagens), nome, data, quem anexou
- Botões Visualizar (modal com signed URL), Baixar (signed URL download), Apagar (confirm + soft delete)
- Realtime opcional (não essencial)

**Edge function não necessária:** SDK supabase-js cobre upload/signed URL/delete diretamente com RLS no bucket.

---

### Fase 4 — Observações em empréstimos

**Em criação (`NewLoanPage`):** campo "Observação" no formulário, salva em `loans.observation`.

**Em detalhe do empréstimo (`LoanDetailPage`):**
- Mostrar observação atual
- Botão "Editar observação" → dialog com textarea
- Save: update + log_audit com old/new
- Mostrar nome principal do cliente (clicável → `/clients/:id`) e nome completo abaixo
- Mostrar telefone

**Em renovação:** o `NewLoanPage` em modo `renewFrom` já cria um novo loan — herda o campo observação do form.

**Em quitação:** atualmente quitação é apenas pagamento total; vou adicionar campo observação opcional no modal de pagamento que marca `loans.observation` ao quitar (append com timestamp).

---

### Detalhes técnicos

- Migrações: 1 migração com ALTERs + nova tabela + bucket + policies
- Adapto `admin_create_client` para receber os novos parâmetros (mantendo retrocompatibilidade via DEFAULT NULL)
- Toda mutação de cliente → `logAction("editar_cliente","client",id,old,new)` (helper já existe em `src/lib/audit-utils.ts`)
- Histórico de alterações: novo componente `ClientHistory` que faz `select * from audit_logs where entity='client' and entity_id=:id order by created_at desc`
- Validações com `zod` (já no projeto via shadcn forms)

---

### Riscos

- `admin_create_client` é SECURITY DEFINER — alterar assinatura requer DROP + CREATE; faço com IF EXISTS
- Bucket Storage policies precisam estar corretas para web e Android (URLs assinadas funcionam em ambos)
- Não toco em lógica financeira (`apply_loan_payment`, `daily_events`, `remaining_balance`)

Aprova para eu seguir as 4 fases em sequência no mesmo turno?
