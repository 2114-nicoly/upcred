## Melhorias na área do trabalhador (UpCred)

Escopo: melhorias de UX, textos, confirmações, anexos e persistência de rascunhos. Sem redesenhar layout. Mobile-first.

---

### 1. Dashboard de produção do trabalhador

Adicionar bloco de indicadores no topo da **Rota do Dia** (`DailyCashPage.tsx` ou `TodayPage.tsx` — verificar qual é o painel inicial do trabalhador) usando dados já carregados:

- Clientes tratados / pagos / não pagos / pendentes restantes
- Total recebido (cash_movements `recebimento_normal`)
- Total liberado em empréstimos (cash_movements `emprestimo_liberado`)
- Multas recebidas (cash_movements `recebimento_multa`)
- Saldo esperado do dia (de `daily_cash.expected_closing_balance`)
- Badge "Caixa aberto/fechado"

Grid 2 colunas mobile, cards compactos com semantic tokens.

### 2. Padronização de nomes (i18n leve)

Renomear labels em `AppLayout.tsx`, `Breadcrumb.tsx`, menus e títulos de página:

- "Rota" → "Rota do Dia"
- "Geral" / "Caixa" → "Caixa do Dia"
- "Histórico" → "Histórico do Caixa"
- "Relatório" → "Relatório Diário"

Apenas labels visuais, sem renomear rotas/arquivos.

### 3. Estados vazios profissionais

Criar componente reutilizável `src/components/EmptyState.tsx` com ícone + título + descrição + ação opcional.

Aplicar em:
- `DailyCashPage` (sem parcelas hoje)
- `ClientsPage` (nenhum cliente encontrado / busca vazia)
- `CaixaPage` (sem movimentação)
- `PaymentHistoryPage` (sem pagamentos)
- `DailyReportPage` / `DailyCashHistoryPage` (sem relatório)

### 4. Confirmações em ações sensíveis

Já existe `useConfirm` com `affected`. Garantir uso em:
- Pagamento alto (> R$ X ou quitação)
- Quitação total
- Estorno (já tem)
- Cancelamento de empréstimo
- Renovação
- Renegociação
- Fechamento do caixa (já tem dialog dedicado)
- Saída manual / ajuste manual no Caixa do Dia

Mostrar nome do cliente, valor e impacto (ex: "Quita o contrato", "Reduz saldo em R$ 50").

### 5. Anexos com categoria + anexos no cadastro

**5a. Categoria no `client_attachments`:** adicionar coluna `category text` (Documento, Comprovante, Contrato, Foto, Outro) via migration. Atualizar `ClientAttachments.tsx` com `<Select>` de categoria e badge da categoria nas listagens.

**5b. Anexos antes de criar cliente:** em `ClientForm.tsx` (modo criação), armazenar arquivos `File[]` em estado local + metadados (nome, categoria). Após `INSERT` do cliente, fazer upload em sequência para o storage, criar registros em `client_attachments` com o novo `client_id`. Persistir metadados no draft (não os blobs em si — File não serializa, mas podemos manter os File em memória + mostrar lista no draft restaurado pedindo re-seleção dos arquivos físicos se a aba foi fechada).

### 6. Autosave de rascunhos (localStorage)

Criar hook `src/hooks/useFormDraft.ts`:

```ts
useFormDraft<T>(key: string, value: T, opts?: { debounceMs?: number; enabled?: boolean })
```

- Persiste em `localStorage` com chave escopada: `upcred:draft:{userId}:{key}`
- Debounce 500ms
- Retorna `{ hasDraft, restore, clear }`
- Não inclui campos de senha (filtro por nome no hook + guideline)

Aplicar nos formulários:
- Novo cliente (`ClientForm` em modo create) — chave `new-client`
- Editar cliente — chave `edit-client:{clientId}`
- Novo empréstimo (`NewLoanPage`) — chave `new-loan:{clientId}`
- Renovação / renegociação (`LoanDetailPage` dialogs) — chave `renew:{loanId}` / `renegotiate:{loanId}`
- Modal de pagamento — chave `payment:{installmentId}` (limpar ao confirmar)
- Anexos pendentes do form de cliente — chave `attachments-draft:new-client` (apenas metadados)

Ao abrir tela com rascunho existente: toast discreto "Rascunho restaurado · [Descartar]". Ao concluir com sucesso → `clear()`.

### 7. Segurança dos rascunhos

- Chave inclui `userId` (do `useAuth`); na ausência de sessão, não persiste
- Lista de campos proibidos: `password`, `senha`, `token`
- Limpar TODOS os drafts do usuário no logout (`useAuth` signOut)

### 8. Sem mudar layout geral

Apenas refinos. Manter tokens existentes.

### 9. Validação

`tsc --noEmit` no fim e correção de erros.

---

### Arquivos a criar/editar

**Criar:**
- `src/components/EmptyState.tsx`
- `src/hooks/useFormDraft.ts`
- `src/components/WorkerDashboard.tsx` (bloco de indicadores)
- Migration: `client_attachments.category`

**Editar:**
- `src/pages/DailyCashPage.tsx` (dashboard + empty state + confirmações em manuais)
- `src/pages/ClientsPage.tsx` (empty state)
- `src/pages/CaixaPage.tsx` (empty states + confirmação fechamento já existe)
- `src/pages/PaymentHistoryPage.tsx`, `DailyReportPage.tsx`, `DailyCashHistoryPage.tsx` (empty states)
- `src/pages/LoanDetailPage.tsx` (confirmações renovação/renegociação + draft)
- `src/pages/NewLoanPage.tsx` (draft)
- `src/components/ClientForm.tsx` (draft + anexos pendentes)
- `src/components/ClientAttachments.tsx` (categoria)
- `src/components/AppLayout.tsx` + `Breadcrumb.tsx` (renomeação de labels)
- `src/hooks/useAuth.tsx` (limpar drafts no signOut)

Migração precisa de aprovação antes do código.