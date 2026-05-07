
# Hierarquia profissional Super Admin / Admin / Trabalhador

Esse é um trabalho grande. Vou entregar em **fases incrementais**, cada uma testável isoladamente, sem quebrar a lógica financeira atual (`remaining_balance`, `cash_date`, parcelas, renovação, desfazer, 1 empréstimo ativo por cliente).

---

## Fase 1 — Base de contexto e navegação (sem mudar dados)

Objetivo: dar ao Super Admin/Admin a sensação de "entrar" em outro escopo, com indicador visual e breadcrumb, reusando as telas que já existem.

**Frontend**
- Novo `ScopeContext` (extensão de `useWorkerFilter`) com:
  - `viewingAdminId`, `viewingAdminName`
  - `viewingWorkerId`, `viewingWorkerName`
  - `clearScope()`
- Novo componente `ScopeBanner` fixo no topo (abaixo do header) com:
  - "Visualizando Administrador: Maria" / "Visualizando Trabalhador: João"
  - Botão "Sair desta visão"
- Novo componente `Breadcrumb` simples (Super Admin > Maria > João > Rota).
- `AppLayout` injeta `ScopeBanner` quando há escopo ativo.
- Menu lateral muda conforme role (já existe parcialmente):
  - Trabalhador: Rota, Geral, Clientes, Ativos, Histórico, Relatórios
  - Admin: Dashboard, Trabalhadores, Clientes, Empréstimos, Caixa, Relatórios, Auditoria
  - Super Admin: Dashboard, Administradores, Trabalhadores, Clientes, Empréstimos, Caixa, Relatórios, Auditoria, Manutenção
- Rota não aparece como item operacional de Admin/Super Admin — só dentro do painel do trabalhador.

**Backend**: nenhum.

---

## Fase 2 — Painel do Trabalhador (visão profunda)

Reaproveita `AdminWorkerDetailPage` e expande.

**Página `/admin/worker/:id`** (Admin) e **`/super-admin/worker/:id`** (Super Admin), com abas:
- Resumo (KPIs do trabalhador)
- Rota (lê-only, com confirmação se for atuar em nome dele)
- Caixa/Geral
- Clientes
- Empréstimos Ativos
- Histórico (pagamentos, não pagos, renovações, novos, retiradas, aportes)
- Relatórios
- Auditoria

Cabeçalho mostra: nome, login, status, criado em, **administrador responsável**.

Setando `viewingWorkerId` no contexto, todas as queries das abas filtram por esse worker via filtro já existente.

**Backend**: RPC novo `worker_full_summary(p_worker_id)` retorna KPIs (clientes ativos, empréstimos ativos, total emprestado, recebido período, atrasos). RLS já cobre escopo.

---

## Fase 3 — Painel do Administrador (visão da equipe)

Expandir `SuperAdminDetailPage` para abas idênticas ao painel do admin real:
- Resumo da equipe
- Trabalhadores (lista clicável → painel do trabalhador)
- Clientes da equipe (com agrupamento por trabalhador)
- Empréstimos da equipe (com agrupamento por trabalhador, filtro status)
- Caixa da equipe
- Relatórios da equipe
- Auditoria da equipe

Setando `viewingAdminId`, todas as telas existentes (Clientes, Empréstimos, Caixa, Relatórios, Auditoria) passam a filtrar por esse admin automaticamente — reaproveitamento total.

Auditoria registra `super_admin_view_admin_panel`.

---

## Fase 4 — Listas hierárquicas (Clientes & Empréstimos)

**Clientes (`ClientsPage`)**
- Super Admin: filtro por administrador → dentro, agrupamento por trabalhador (collapsible).
- Admin: agrupamento por trabalhador (collapsible).
- Cada card de cliente mostra "Trabalhador: X" e (Super Admin) "Admin: Y".

**Empréstimos (`ActiveLoansPage`, `OverdueLoansPage`)**
- Mesma lógica: filtro admin (Super), agrupamento por trabalhador (Super/Admin).
- Cada card mostra cliente, trabalhador, admin (Super), saldo, total pago, status, dias atraso.

**Caixa**
- Super Admin: consolidado + filtro admin + filtro trabalhador.
- Admin: consolidado equipe + filtro trabalhador.
- Já temos boa parte via `WorkerFilterSelect`; só adicionar agrupamento.

---

## Fase 5 — Relatórios hierárquicos

`ReportsPage` ganha 3 níveis:
- Geral / Por Administrador / Por Trabalhador
- Períodos: dia, semana seg–dom, mês, custom
- Indicadores já listados (previsto, recebido, falta, %, emprestado, retirado, aportado, líquido, não pagos, atrasados, renovações, novos, clientes ativos, ativos)

Implementar novo RPC `report_consolidated(p_scope, p_admin_id, p_worker_id, p_start, p_end)` que centraliza todos os indicadores a partir de `daily_events` + `loans` + `installments`.

---

## Fase 6 — Gestão de trabalhadores: arquivar / excluir / transferir

**Backend (migration)**:
- Coluna `workers.archived_at timestamptz`.
- RPC `archive_worker(p_worker_id)` — desativa + marca arquivado, mantém histórico.
- RPC `delete_worker_safe(p_worker_id)`:
  - exige Super Admin
  - exige `active = false`
  - se tiver clientes/empréstimos/eventos → recusa, sugere "arquivar"
  - só apaga se totalmente sem dados
  - registra auditoria
- RPC `transfer_worker_to_admin(p_worker_id, p_to_admin_id)` — só Super Admin; atualiza `parent_admin_id` do worker, e `admin_id` dos seus clientes/empréstimos ativos; preserva histórico; auditoria.
- RPC `set_worker_active` já existe — mantém.
- Filtros em todas as listagens excluem workers arquivados por padrão (toggle "mostrar arquivados").

**Frontend**:
- Botões em `WorkersPage` e painel do trabalhador: Ativar/Desativar, Arquivar, Excluir (Super), Transferir para outro admin (Super).
- Confirmações fortes (já existe `useConfirm`).

---

## Fase 7 — Confirmação ao agir "em nome de" trabalhador

Quando Admin/Super Admin estiver com `viewingWorkerId` ativo e disparar uma ação operacional (pagamento, novo empréstimo, retirada, aporte, renovação, marcar não pago):
- `useConfirm`: "Você está registrando uma ação em nome de João. Continuar?"
- Auditoria salva: `action_by`, `user_role`, `worker_id` afetado, `admin_id`, antes/depois, observação "ação em nome de".

Isso usa o `logAction` já existente, só adicionando o flag de impersonação.

---

## Fase 8 — RLS / segurança

Revisar e (se necessário) endurecer:
- Workers só veem o que é deles (RLS atual cobre).
- Admin não pode mudar `parent_admin_id` de worker (trigger).
- Trabalhador não pode mudar `worker_id`/`admin_id` (trigger).
- Apenas Super Admin executa `transfer_worker_to_admin` e `delete_worker_safe`.
- `Admin manage own workers` — restringir UPDATE para não permitir mudar `parent_admin_id` (trigger `workers_protect_fields` já existe; estender).

---

## Detalhes técnicos

```text
Rotas novas
/admin                  Painel Admin (já existe — abas)
/admin/worker/:id       Painel Trabalhador (já existe — expandir abas)
/super-admin            Lista de Admins (já existe)
/super-admin/:adminId   Painel Admin do ponto de vista do Super Admin (expandir abas)
/super-admin/worker/:id Painel Trabalhador (Super Admin)
```

```text
Componentes novos
src/components/ScopeBanner.tsx
src/components/Breadcrumb.tsx
src/components/HierarchyClientList.tsx   (agrupado por admin/worker)
src/components/HierarchyLoanList.tsx
src/components/WorkerFullPanel.tsx       (abas reutilizáveis)
src/components/AdminFullPanel.tsx        (abas reutilizáveis)
```

```text
Migrations novas
- workers.archived_at + índice
- RPC archive_worker / delete_worker_safe / transfer_worker_to_admin
- RPC worker_full_summary / report_consolidated
- Trigger reforçando workers_protect_fields para parent_admin_id
```

---

## Como propus entregar

Por causa do tamanho, sugiro fazer **uma fase por mensagem**, na ordem 1 → 8, cada uma com build verde antes de seguir. Isso evita um PR gigante difícil de revisar e mantém o app sempre utilizável.

**Confirma se posso começar pela Fase 1 (contexto + banner + breadcrumb + menus por role)?**  
Se preferir outra ordem ou agrupar fases, me diga.
