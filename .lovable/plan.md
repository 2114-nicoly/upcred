## Reorganização de Menu, Permissões e Navegação por Role

Vou reorganizar completamente a navegação do app para que cada tipo de usuário (trabalhador, admin, super_admin) veja apenas o que faz sentido para sua função. A lógica financeira existente (remaining_balance, parcelas, daily_events, RLS) NÃO será alterada.

---

### Fase 1 — AppLayout: menus por role

Reescrever `AppLayout.tsx` para gerar 3 conjuntos de itens de menu distintos:

**Trabalhador (sidebar + bottom nav):**
- Bottom nav: Rota, Geral
- Sidebar: Rota, Geral (Caixa), Clientes, Empréstimos Ativos, Histórico, Relatórios, Sair

**Admin (sem Rota no menu principal):**
- Bottom nav: Painel, Caixa da Equipe
- Sidebar: Dashboard Admin, Trabalhadores, Clientes da Equipe, Empréstimos da Equipe, Caixa da Equipe, Relatórios, Auditoria, Configurações
- Acesso à Rota só dentro do painel do trabalhador

**Super Admin:**
- Bottom nav: Dashboard Geral, Caixa Geral
- Sidebar: Dashboard Geral, Administradores, Trabalhadores, Clientes, Empréstimos, Caixa Geral, Relatórios Gerais, Auditoria Geral, Manutenção, Configurações
- Acesso à Rota só via Admin → Trabalhador → Rota

Renomear labels do header (`routeLabels`) conforme role: "Geral" vira "Caixa da Equipe" para admin e "Caixa Geral" para super_admin; "Empréstimos Ativos" vira "Empréstimos da Equipe", etc.

### Fase 2 — Bloqueio de rotas por URL

Em `App.tsx`, adicionar guards adicionais:
- `WorkerOnlyRoute` (opcional) ou `RoleRoute({ allow: [...] })` genérico.
- `/` (Rota), `/caixa` direto: trabalhador acessa livremente; admin/super_admin são redirecionados para seu dashboard correspondente (`/admin` ou `/super-admin`).
- `/admin/*` continua bloqueado para trabalhador (já existe `AdminRoute`).
- `/super-admin/*` continua bloqueado para admin não-super (já existe `SuperAdminRoute`).
- Rota da operação em nome do trabalhador: usar `/admin/worker/:id/rota`, `/admin/worker/:id/caixa`, etc., dentro do contexto do worker selecionado (define `selectedWorkerId` automaticamente via `useWorkerFilter`).

### Fase 3 — Painel individual do trabalhador (admin/super_admin)

Estender `AdminWorkerDetailPage` para conter abas:
- Resumo (já existe)
- Rota (embed da TodayPage com worker filtrado)
- Caixa do trabalhador
- Clientes do trabalhador
- Empréstimos do trabalhador
- Histórico
- Relatórios
- Auditoria

Cada aba reutiliza a página existente, mas força `selectedWorkerId = id` via `useWorkerFilter`.

### Fase 4 — Dashboards

**Dashboard Admin (`/admin`)**: ajustar `AdminPanelPage` para mostrar consolidado da equipe — previsto/recebido/falta receber hoje/semana/mês, dinheiro emprestado, retirado, adicionado, saldo líquido, atrasados, não pagos, contagens (clientes, empréstimos, trabalhadores ativos).

**Dashboard Geral (`/super-admin`)**: ajustar `SuperAdminPage` para visão consolidada do sistema + filtros (admin, trabalhador, dia/semana/mês/período).

Estes dashboards usarão as funções e tabelas já existentes (`super_admin_stats_by_admin`, `daily_events`, `loans`, etc.). Sem mudanças de schema.

### Fase 5 — Cards enriquecidos

**Workers (admin):** card com nome, login, status, clientes ativos, empréstimos ativos, previsto hoje, recebido hoje, não pagos hoje, atrasados, saldo em aberto, recebido semana/mês.

**Admins (super_admin):** card com nome, email, login, status, qtd trabalhadores, clientes ativos, empréstimos ativos, previsto/recebido hoje, atrasados, não pagos, recebido semana/mês, saldo líquido.

Implementação via agregações client-side com queries paralelas filtradas por `admin_id` / `worker_id`. Sem migrations.

### Fase 6 — Operação em nome de trabalhador

Quando admin/super_admin estiver dentro do painel de um trabalhador e fizer uma ação financeira:
- Mostrar diálogo de confirmação: "Você está registrando uma ação em nome de [nome]. Continuar?"
- Registrar via `log_audit` com `p_obs` indicando contexto (`acting_as_worker`).
- Audit_logs já capturam `user_id`, `user_role`, `worker_id`, `admin_id` automaticamente — só precisamos garantir que `worker_id` afetado seja passado.

### Fase 7 — Não-regressão

Não tocar em: lógica de pagamento (`apply_loan_payment`), parcelas, `remaining_balance`, daily_events, Rota do trabalhador, Caixa, Relatórios por `cash_date`, Renovação, Histórico, regra "1 empréstimo ativo por cliente", scoping multiusuário.

---

### Detalhes técnicos

**Arquivos editados:**
- `src/components/AppLayout.tsx` — menus condicionais por role + labels dinâmicos
- `src/App.tsx` — guards de rota (redirect inteligente para `/`, `/caixa`)
- `src/pages/AdminWorkerDetailPage.tsx` — abas completas com contexto worker forçado
- `src/pages/AdminPanelPage.tsx` — dashboard admin com KPIs
- `src/pages/SuperAdminPage.tsx` — dashboard geral + filtros + cards de admin
- `src/pages/WorkersPage.tsx` — cards enriquecidos
- `src/hooks/useWorkerFilter.tsx` — método para forçar contexto via URL param

**Sem migrations.** Tudo usa schema atual, RPCs e RLS já existentes. A segurança real continua na RLS do Postgres; o menu apenas oculta o que o usuário não deve ver.

---

### Confirmação

Posso prosseguir com a Fase 1 (menus por role + bloqueio de rota direta) e seguir para as demais? Ou prefere implementar uma fase por vez com aprovação intermediária?
