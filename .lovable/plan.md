## Fase 2 — Painel Admin, Filtros por Trabalhador, Transferência e Auditoria

### Visão geral
Implementar visão consolidada do admin com filtro por trabalhador em todas as telas operacionais, criar Painel Admin com comparativo, transferência de cliente (apenas empréstimo ativo) e auditoria completa de ações.

---

### 1) Banco de dados (migração única)

**Nova tabela `audit_logs`**
- `user_id` (quem fez), `user_role`, `worker_id` (escopo do dado), `action_type`, `entity_type`, `entity_id`, `old_value` (jsonb), `new_value` (jsonb), `observation`, `created_at`
- RLS: admin vê tudo; trabalhador vê apenas onde `worker_id = get_worker_id(auth.uid())` E `user_id = auth.uid()`

**Nova tabela `client_transfers`**
- `client_id`, `loan_id`, `from_worker_id`, `to_worker_id`, `transferred_by` (admin), `transferred_at`, `observation`
- RLS: admin gerencia; trabalhador vê transferências que envolvem seu próprio worker_id

**Função `admin_transfer_client(p_client_id, p_to_worker_id, p_observation)`**
- SECURITY DEFINER, somente admin
- Move cliente e SOMENTE o empréstimo ativo + parcelas pendentes para o novo `worker_id`
- Pagamentos, eventos, caixas e empréstimos antigos permanecem com worker_id original
- Grava em `client_transfers` e `audit_logs`

**Função `log_audit(p_action, p_entity, p_entity_id, p_old, p_new, p_obs, p_worker_id)`**
- Helper SECURITY DEFINER para inserir na tabela de logs sem expor RLS

---

### 2) Hook de contexto admin

**`src/hooks/useWorkerFilter.tsx`**
- Estado global do filtro de trabalhador selecionado pelo admin (persistido em localStorage)
- Valores: `null` = consolidado (todos), ou `worker_id` específico
- Lista de trabalhadores ativos
- Helper `applyWorkerFilter(query)` que adiciona `.eq("worker_id", id)` se filtro ativo

**`src/lib/audit-utils.ts`**
- `logAction(action_type, entity_type, entity_id, old?, new?, obs?)`
- Chamada após cada operação sensível

---

### 3) Filtro de trabalhador nas telas operacionais

Adicionar dropdown "Trabalhador" (visível só para admin) no topo de:
- **TodayPage** (Rota)
- **CaixaPage / DailyCashPage** (Geral)
- **ActiveLoansPage** (Empréstimos Ativos)
- **OverdueLoansPage** (Atrasados)
- **ReportsPage** (Relatórios)
- **ClientsPage** (Clientes)
- **CashHistoryPage / DailyCashHistoryPage**

Comportamento:
- Default: "Todos os trabalhadores" (consolidado)
- Opções: Todos + lista de trabalhadores ativos
- Trabalhador comum: dropdown oculto, vê só os próprios dados (já garantido por RLS)
- Badge com nome do trabalhador em cada item nas listas consolidadas

---

### 4) Painel Admin (`/admin`)

Substituir/expandir a `WorkersPage` atual em uma nova `AdminPanelPage` com abas:

**Aba 1 — Visão Geral (consolidado)**
- Cards do dia: previsto, recebido, falta receber, %, emprestado, retirado, aportado, saldo líquido, clientes ativos, empréstimos ativos, atrasados, trabalhadores ativos
- Mesmos cards para semana (seg-dom), mês, período personalizado
- Cada card é clicável → drill-down

**Aba 2 — Trabalhadores**
- Lista de cards de trabalhadores com: nome, login, status, clientes ativos, empréstimos ativos, previsto hoje, recebido hoje, não pagos hoje, atrasados, saldo em aberto, recebido semana, recebido mês, saldo líquido período
- Ações: criar, redefinir senha, ativar/desativar
- Click no card → `/admin/worker/:id` (painel individual)

**Aba 3 — Comparativo**
- Tabela ranking: trabalhador | previsto | recebido | % | não pagos | atrasados | emprestado | retirado | aportado | saldo líquido
- Ordenável por coluna; filtro de período (dia/semana/mês/personalizado)

**Aba 4 — Auditoria**
- Lista de logs com filtros: usuário, trabalhador, tipo de ação, período
- Mostra valor anterior vs valor novo

---

### 5) Painel individual do trabalhador (`/admin/worker/:id`)

Página completa com:
- Resumo dia/semana/mês/personalizado
- Atalhos: Clientes do trabalhador, Empréstimos ativos, Rota, Caixa, Pagamentos, Não pagos, Renovações, Empréstimos novos, Retiradas, Aportes
- Botão "Ver como este trabalhador" → ativa filtro global e navega para Rota
- Histórico de ações desse trabalhador (audit_logs filtrado)

---

### 6) Transferência de cliente

**Botão "Transferir para outro trabalhador"** em:
- `ClientDetailPage` (apenas admin)
- Card de trabalhador no admin → transferir cliente específico

**Diálogo de transferência:**
- Selecionar trabalhador destino
- Mostrar resumo: cliente X, empréstimo ativo Y (R$ Z), N parcelas pendentes
- Aviso: "Histórico antigo permanece com o trabalhador atual"
- Campo observação
- Confirmação → chama `admin_transfer_client`

---

### 7) Logs de auditoria

Instrumentar `logAction(...)` em:
- Criação/edição/exclusão: cliente, empréstimo, parcela
- Pagamento, desfazer pagamento, edição de pagamento
- Marcar não pagou
- Renovação, quitação
- Aporte, retirada, ajuste manual de caixa
- Fechamento de caixa
- Criação/reset/ativar trabalhador
- Transferência de cliente

---

### 8) Identificação visual

- Header: badge "Admin" quando admin logado; quando filtro ativo → mostrar "Vendo: {nome do trabalhador}" com botão limpar
- Quando consolidado: "Visão consolidada"
- Listas consolidadas: mini-badge `[trabalhador]` em cada item

---

### Detalhes técnicos

**Cálculo da semana:** `startOfWeek(d, { weekStartsOn: 1 })` até `endOfWeek(d, { weekStartsOn: 1 })` (segunda a domingo).

**RLS:** já garantida pelas policies existentes (`has_role(admin) OR worker_id = get_worker_id(uid)`). O filtro do admin é aplicação-side (`.eq("worker_id", x)`), nunca remove a verificação RLS.

**Performance:** consultas consolidadas paralelizadas com `Promise.all`. Hooks leves para não recarregar tudo ao trocar de aba.

**Trabalhador comum:** todas as novas rotas admin (`/admin/*`) protegidas por guard `if (!isAdmin) navigate("/")`.

### Estrutura de arquivos

```text
src/
  hooks/
    useWorkerFilter.tsx          (novo, contexto global)
  lib/
    audit-utils.ts               (novo)
    consolidated-stats.ts        (novo, agregações)
  pages/
    AdminPanelPage.tsx           (novo, com abas)
    AdminWorkerDetailPage.tsx    (novo)
    WorkersPage.tsx              (mantido, vira aba)
  components/
    WorkerFilterSelect.tsx       (novo, dropdown)
    TransferClientDialog.tsx     (novo)
    AuditLogList.tsx             (novo)
supabase/migrations/             (audit_logs + client_transfers + funções)
```

### Fora do escopo desta entrega
- Edição inline de trabalhadores (mantém o que já existe)
- Exportação de relatórios em PDF/Excel
- Notificações em tempo real (realtime)
