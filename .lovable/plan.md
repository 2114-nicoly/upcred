## Objetivo
Corrigir definitivamente o sistema multiusuário (Super Admin / Admin / Trabalhador): credenciais visíveis, geração de nova senha funcional, vínculos corretos de clientes a trabalhadores, equipe do admin populada, e Super Admin separado de admins comuns.

Vou dividir em **6 frentes** entregues em sequência, sem quebrar pagamentos, RLS, Rota, Caixa, Renovação ou Auditoria.

---

### Frente 1 — Credenciais e geração de senha (backend)

**Migrations:**
- Garantir que `worker_credentials_log` tenha índice por `(worker_id, created_at desc)` e `(admin_id, created_at desc)`.
- Criar RPC `get_latest_credential(p_kind, p_target_id)` que retorna `{login_codigo, temp_password, created_at, created_by, reason, status}` com permissão:
  - super_admin: tudo
  - admin: apenas trabalhadores onde `parent_admin_id = get_admin_id(auth.uid())`
  - trabalhador: bloqueado
- Criar RPC `list_password_recovery_alerts()` que retorna pendências visíveis ao chamador (super_admin vê todas; admin vê apenas as do próprio time).

**Edge functions** (`admin-create-user`, `admin-reset-password`):
- Já geram login + senha e gravam em `worker_credentials_log`. Garantir que o retorno JSON sempre inclua `login_codigo` e `password` para o frontend exibir.
- Garantir que admin comum só consiga resetar trabalhador do próprio time (já implementado — verificar e reforçar).
- Senha de admin gera 5 dígitos? Atualmente `gen(8)` — manter 8 dígitos por segurança (login é que tem 4/5). Confirmar com pedido: o pedido fala em "senha temporária de 8 dígitos" para ambos ✅.

### Frente 2 — UI de credenciais

- `CredentialsDialog`: garantir que sempre exiba `login` + `password` + `nome` + `role` + `created_at` + `created_by` quando vierem do edge function.
- Em `AdminWorkerDetailPage` e `SuperAdminDetailPage`/`SuperAdminWorkerDetailPage`: adicionar seção **"Acesso"** com:
  - login atual
  - botão "Gerar nova senha" (chama edge function e abre `CredentialsDialog` com a nova senha)
  - última redefinição (data + quem) via `get_latest_credential`
  - status ativo/inativo/arquivado
- Trabalhador: NÃO mostrar nada disso.

### Frente 3 — Esqueci senha → alertas

- Tabela `password_recovery_requests` já existe.
- Frontend: badge no `AppLayout` (sino) para admin/super_admin com contagem de `status='open'` via `list_password_recovery_alerts`.
- Página/dialog "Solicitações de senha pendentes":
  - lista cada solicitação com nome, login, data
  - botão "Gerar nova senha" → chama `admin-reset-password` → marca `password_recovery_requests.status='resolved'`, `resolved_by=auth.uid()`, `resolved_at=now()` → exibe `CredentialsDialog`
- Auditoria registrada via `log_audit('redefinir_senha', ...)` (já existe).

### Frente 4 — Equipe do admin (visibilidade dos trabalhadores)

- `AdminPanelPage` / `AdminPage`: garantir que use `admin_list_workers()` (RPC) — já filtra por `parent_admin_id`.
- Para Super Admin clicando em um admin específico: usar `list_workers_by_admin(p_admin_id)`.
- Card de trabalhador deve mostrar todos os campos pedidos: nome, login, status, admin responsável, contadores (clientes ativos, empréstimos ativos, recebido hoje/semana, atrasados, não pagos, saldo aberto). Adicionar RPC `worker_dashboard_stats(p_worker_id)` que devolve esses números em uma chamada.
- Estado vazio correto.

### Frente 5 — Super Admin separado de admins comuns

- `super_admin_list_admins()` atualmente retorna todos de `admins`. Filtrar para excluir registros cujo `auth_user_id` tenha role `super_admin` em `user_roles`. Implementar via SQL na própria function.
- Frontend `SuperAdminPage`: já consome essa RPC — ficará automaticamente correto.

### Frente 6 — Cliente sempre com trabalhador

**Backend:**
- Criar RPC `worker_create_client(p_name, p_phone, ...)` que pega `worker_id = get_worker_id(auth.uid())` e `admin_id = parent_admin_id` automaticamente — bloqueia se trabalhador não tiver admin.
- Validação: trigger `BEFORE INSERT ON clients` que rejeita inserts sem `worker_id`+`admin_id` (exceto super_admin com bypass explícito).
- Exception: super_admin pode criar atribuindo manualmente (já tem `admin_create_client` com `p_worker_id`).
- Edição simples NÃO pode alterar `worker_id`/`admin_id`. Adicionar trigger `BEFORE UPDATE ON clients` que rejeita mudança de `worker_id`/`admin_id` exceto via `admin_transfer_client` (usar GUC `app.allow_client_transfer = 'true'` setado dentro da RPC).
- Reaproveitar `admin_transfer_client` (já existe e registra auditoria + `client_transfers`).

**Frontend:**
- `ClientForm` no fluxo trabalhador: usar `worker_create_client`.
- `ClientForm` no fluxo admin: continuar usando `admin_create_client` com seleção obrigatória de trabalhador.
- Esconder/desabilitar campo "trabalhador" na edição simples.
- Listagem de clientes: agrupar por trabalhador para admin/super_admin (collapsible accordion). Trabalhador vê lista plana.
- Exibir badge "Trabalhador: X" em cada card de cliente em todas as telas.
- Manutenção: adicionar card "Clientes sem trabalhador responsável" usando `admin_find_orphans()` (já existe) com botão "Atribuir trabalhador".

### Itens 11, 12, 13, 14, 15 (cross-cutting)

- **Nome clicável**: revisar listas/cards e envolver `<Link to={`/clients/${id}`}>` onde aparecer nome. Páginas: ActiveLoansPage, OverdueLoansPage, TodayPage, NewLoanPage, ReportsPage, PaymentHistoryPage, AuditPage, painéis admin.
- **Contexto visual**: header com "Equipe de: X" / "Trabalhador selecionado: Y" via `useWorkerFilter` (já existe `ScopeIndicator`) — verificar que aparece nas páginas administrativas.
- **Auditoria**: confirmar que cada ação relevante chama `logAction(...)`.
- **RLS**: já está sólida — apenas adicionar as triggers do item 6 e a filtragem do item 5.

---

### Detalhes técnicos

```
Migration 1 — Frente 1, 5, 6:
  - CREATE OR REPLACE FUNCTION get_latest_credential(...)
  - CREATE OR REPLACE FUNCTION list_password_recovery_alerts()
  - CREATE OR REPLACE FUNCTION worker_create_client(...)
  - CREATE OR REPLACE FUNCTION worker_dashboard_stats(...)
  - CREATE OR REPLACE FUNCTION super_admin_list_admins() — filtra super_admins
  - TRIGGER clients_require_scope BEFORE INSERT
  - TRIGGER clients_lock_scope BEFORE UPDATE (só permite mudança via GUC setado pela RPC de transferência)
  - Atualizar admin_transfer_client para setar a GUC
  - Índices em worker_credentials_log
```

### Não escopo / não tocar
- Lógica de pagamento, `apply_loan_payment`, `reverse_loan_payment`
- Geração de parcelas
- Cálculo de Rota, Caixa, Geral
- RLS existentes (apenas leituras adicionais)
- Renovação, fechamento de caixa, daily_events

### Ordem de entrega
1. Migration única com todas as RPCs/triggers/índices
2. Atualizar `CredentialsDialog` e detalhe de admin/trabalhador para "Gerar nova senha" + área Acesso
3. Sino + página de solicitações pendentes
4. `worker_create_client` no fluxo trabalhador + agrupar clientes por trabalhador
5. Manutenção: card de clientes sem trabalhador
6. Sweep de "nome clicável" nas listagens

Confirma para eu seguir?
