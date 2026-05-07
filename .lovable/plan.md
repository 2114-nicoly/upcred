# Plano: Hierarquia super_admin → admin → trabalhador

Transformar o atual modelo de 2 níveis (admin único + trabalhadores) em 3 níveis com escopo por equipe, mantendo toda a lógica financeira atual (remaining_balance, daily_events, cash_date, renovação, desfazer pagamento).

## Visão geral

```text
super_admin (nicknicoly2114@gmail.com)
   ├── admin A ──── trabalhadores A1, A2, A3
   ├── admin B ──── trabalhadores B1, B2
   └── admin C ──── trabalhador C1
```

- super_admin: vê tudo, cria admins.
- admin: vê só sua equipe, cria trabalhadores da própria equipe.
- trabalhador: vê só os próprios dados.

## 1. Banco de dados (migrations)

### 1.1 Roles
- Adicionar valor `super_admin` ao enum `app_role` (já existem `admin` e `trabalhador`).
- Promover `nicknicoly2114@gmail.com` para `super_admin` (manter `admin` para compatibilidade com policies atuais).

### 1.2 Hierarquia em `workers` e novo conceito de admin
- Criar tabela `admins` (espelho de `workers` mas para administradores):
  - `id`, `auth_user_id`, `nome`, `email_real`, `login_codigo` (5 dígitos), `synthetic_email` opcional, `active`, `created_by`, `created_at`, `updated_at`.
- Adicionar coluna `parent_admin_id uuid` em `workers` referenciando `admins.id`.
- Adicionar coluna `admin_id uuid` nas tabelas operacionais para filtragem rápida da equipe:
  - `clients`, `loans`, `cash_movements`, `daily_events`, `daily_cash`, `cash_balance`, `not_paid_marks`, `penalties`, `routes`, `audit_logs`.
- `installments` herda via `loan.admin_id` (não duplica).

### 1.3 Funções helpers (SECURITY DEFINER)
- `is_super_admin(uid)`
- `get_admin_id(uid)` → admin do usuário (admin retorna o próprio; trabalhador retorna parent_admin_id)
- `auto_set_admin_worker_ids()` trigger que preenche `worker_id` e `admin_id` em INSERTs operacionais com base no usuário.

### 1.4 RLS reescrita (todas as tabelas operacionais)
Padrão único:
```sql
USING (
  is_super_admin(auth.uid())
  OR (has_role(auth.uid(),'admin') AND admin_id = get_admin_id(auth.uid()))
  OR worker_id = get_worker_id(auth.uid())
)
```
- `admins`: super_admin gerencia; admin vê só a si.
- `workers`: super_admin tudo; admin gerencia os de `parent_admin_id = self`; trabalhador vê só a si.
- `audit_logs`, `client_transfers`: mesma regra de equipe.

### 1.5 RPCs
- `super_admin_register_admin(nome, email_real, login, password_hash via signUp)`
- `admin_register_worker` → ajustar para preencher `parent_admin_id = get_admin_id(auth.uid())` automaticamente.
- `admin_transfer_client` → validar que destino tem mesmo `parent_admin_id` (super_admin ignora restrição).
- `apply_loan_payment`, `reverse_loan_payment` → manter, ajustar checagem para incluir admin de equipe.
- `log_audit` → preencher `admin_id` automaticamente.

## 2. Frontend

### 2.1 Auth e contexto
- `useAuth`: adicionar `isSuperAdmin`, `adminId` (do admin do usuário, null para super_admin).
- `useWorkerFilter`: estender para `useScopeFilter` com `selectedAdminId` + `selectedWorkerId`.
- Login do admin: email real + senha (não usa login de 4 dígitos).

### 2.2 Telas novas
- `SuperAdminPanelPage` — lista de admins, ranking, filtros por admin.
- `AdminListPage` (super_admin) — CRUD de admins (criar, ativar/desativar, reset senha).
- `AdminDetailPage` — painel da equipe de um admin (KPIs, trabalhadores, transferências).
- Reusar `AdminPanelPage` existente como painel da equipe (escopado por `adminId`).
- Reusar `WorkersPage` filtrado por `parent_admin_id`.

### 2.3 Telas operacionais existentes
- Aplicar filtro de escopo (`adminId` + `workerId`) em: TodayPage, CaixaPage, DailyCashPage, ActiveLoansPage, OverdueLoansPage, ClientsPage, ReportsPage, CashHistoryPage.
- Trabalhador: sem filtro (RLS já bloqueia).
- Admin: filtro mostra apenas trabalhadores da equipe.
- Super_admin: filtro hierárquico admin → trabalhador.

### 2.4 Auditoria
- Adicionar `admin_id` aos logs.
- `AuditLogList`: filtros por admin/trabalhador para super_admin.

## 3. Migração de dados existentes

- Criar 1 admin "default" vinculado ao super_admin atual.
- Atribuir `parent_admin_id` desse admin a todos os workers existentes.
- Backfill `admin_id` em todas as tabelas operacionais a partir de `worker.parent_admin_id`.

## 4. Entrega faseada (recomendado)

Devido ao tamanho, sugiro fazer em 3 entregas:

**Fase A — Banco + roles + RLS** (esta entrega)
- Migration: enum, tabela `admins`, colunas `admin_id`/`parent_admin_id`, RPCs, RLS, backfill, promoção do super_admin.
- Atualizar `useAuth` com `isSuperAdmin`/`adminId`.
- Garantir que telas atuais continuam funcionando.

**Fase B — Painel super_admin**
- `AdminListPage`, criação/reset de admin.
- `SuperAdminPanelPage` com ranking e filtros.
- Filtro hierárquico admin→trabalhador.

**Fase C — Auditoria, transferências e refinamento**
- Aplicar `admin_id` em todos os logs/transferências.
- Comparativos, relatórios consolidados por admin.
- QA final + build.

## Perguntas

1. Confirma a abordagem em 3 fases acima? (Tentar tudo de uma vez é alto risco de quebrar a lógica financeira.)
2. Admin faz login com **email real + senha** (recomendado, padrão Supabase) ou também com **login de 5 dígitos** sintético como os trabalhadores?
3. Os dados atuais do app devem ser mantidos e atribuídos a um admin "default" criado para o super_admin, ou prefere apagar tudo de novo?
