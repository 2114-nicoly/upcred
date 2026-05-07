## Reorganização da Interface Super Admin / Admin

Objetivo: tornar visíveis e óbvios todos os controles de hierarquia já existentes (Super Admin → Admin → Trabalhador → operação), adicionando o que falta (arquivar trabalhador, filtros agrupados, breadcrumbs ativos, menus por role) sem quebrar lógica financeira nem RLS.

---

### Fase A — Backend mínimo (1 migration)

Adicionar suporte a "arquivado" sem quebrar nada existente:

- `workers.archived_at timestamptz NULL` (nulo = não arquivado)
- RPC `archive_worker(p_worker_id uuid)` — só Super Admin ou Admin dono; exige `active=false`; seta `archived_at=now()`.
- RPC `unarchive_worker(p_worker_id uuid)` — limpa `archived_at`.
- RPC `delete_worker_if_empty(p_worker_id uuid)` — só Super Admin; falha se houver clients/loans/daily_events; remove worker + role + auth user link.
- Atualizar `admin_list_workers` e `list_workers_by_admin` aceitando flag `p_include_archived boolean default false`.

RLS já cobre tudo (parent_admin_id). Nenhuma mudança em policies.

---

### Fase B — Navegação por role (menu lateral)

Editar `AppLayout.tsx` para que o menu lateral mostre exatamente os itens descritos no item 11 do briefing, em função de `useAuth().role`:

- **Trabalhador**: Rota, Geral/Caixa, Clientes, Empréstimos Ativos, Histórico, Relatórios, Minha Conta.
- **Admin**: Dashboard Admin, Trabalhadores, Clientes da Equipe, Empréstimos da Equipe, Caixa da Equipe, Relatórios, Auditoria, Configurações.
- **Super Admin**: Dashboard Geral, Administradores, Trabalhadores, Clientes, Empréstimos, Caixa Geral, Relatórios Gerais, Auditoria Geral, Manutenção, Configurações.

Rota deixa de ser item de topo para Admin/Super Admin (acessada via painel do trabalhador).

Breadcrumb (`Breadcrumb.tsx`) já existe — estender labels para novas rotas e garantir botão "voltar" no header das telas internas.

---

### Fase C — Tela Super Admin (Dashboard Geral)

Reorganizar `SuperAdminPage.tsx`:

- Aba **Dashboard** vira a landing: cards de KPIs globais (admins ativos, trabalhadores ativos, clientes ativos, empréstimos ativos, previsto/recebido hoje/semana/mês, saldo líquido, atrasados, não pagos).
- Aba **Administradores**: lista em cards ricos (não só switch). Cada card mostra nome, email, login, status, contagem de trabalhadores, clientes ativos, empréstimos ativos, recebido hoje/semana/mês, saldo, atrasados, não pagos. Botões: **Ver equipe**, **Relatórios**, **Editar**, **Desativar/Reativar**.
- Aba **Ranking** mantém a tabela atual.

Novos helpers em `consolidated-stats.ts` para agregar por admin nos múltiplos períodos numa só chamada.

---

### Fase D — Tela "Equipe de [Admin]"

Refatorar `AdminFullPanel.tsx` (já existe) para bater com o briefing:

- Header: Administrador, email, status, totais (trabalhadores, clientes, empréstimos, recebido hoje/semana/mês).
- Abas: Resumo, **Trabalhadores**, Clientes, Empréstimos, Caixa, Relatórios, Auditoria.
- Aba **Trabalhadores**: cards de cada trabalhador da equipe com nome, login, status, admin responsável, clientes ativos, empréstimos ativos, previsto hoje, recebido hoje, não pagos hoje, atrasados, recebido semana/mês, saldo. Botões: **Ver trabalhador**, **Rota**, **Caixa**, **Clientes**, **Empréstimos**, **Relatórios**, **Editar**, **Desativar/Reativar**, **Arquivar** (só se inativo).
- Toggle "Mostrar arquivados".
- Botões "Rota/Caixa/Clientes" aplicam scope (`setSelectedWorkerId`) e navegam para a tela correspondente.

---

### Fase E — Painel do Trabalhador

Refatorar `WorkerFullPanel.tsx`:

- Header completo conforme briefing.
- Abas: Resumo, **Rota**, Geral/Caixa, Clientes, Empréstimos, Histórico, Relatórios, Auditoria. Cada aba renderiza embed (link ou componente) com scope já fixado nesse trabalhador.

---

### Fase F — Filtros nas listas (Clientes / Empréstimos / Caixa)

- `ClientsPage.tsx`: para Admin/Super Admin, adicionar barra de filtros (Admin, Trabalhador, Status, Atrasados/Ativos) + agrupamento por trabalhador. Cada card exibe "Trabalhador: X" e (Super Admin) "Admin: Y".
- `ActiveLoansPage.tsx` / `OverdueLoansPage.tsx`: mesmos filtros + colunas trabalhador/admin + origem (novo/renovação via `renewed_from_loan_id`).
- `CaixaPage.tsx`: filtros equivalentes para Super Admin/Admin.

---

### Fase G — Arquivamento na lista de Trabalhadores

Em `WorkersPage.tsx` e na aba Trabalhadores do AdminFullPanel:

- Botão "Desativar" quando ativo; "Arquivar" quando inativo; "Excluir definitivamente" (Super Admin, com confirmação) se sem dados.
- Filtro "Mostrar arquivados".
- Badge visual: Ativo / Inativo / Arquivado.

---

### Critério de aceite (item 13 do briefing)

Após a entrega, o usuário deve conseguir, sem adivinhar:
1. Super Admin → ver lista de admins → clicar → ver equipe, trabalhadores, clientes agrupados, arquivar trabalhador inativo.
2. Admin → ver só sua equipe → drill-down em trabalhador → rota/caixa/clientes/empréstimos.
3. Trabalhador → ver apenas seus dados.
Tudo com breadcrumb e botão voltar visíveis, e sem quebrar pagamentos / `remaining_balance` / RLS.

---

### Detalhes técnicos

- **Arquivos novos**: 1 migration; nada além disso (reaproveitar componentes).
- **Arquivos editados**: `AppLayout.tsx`, `Breadcrumb.tsx`, `SuperAdminPage.tsx`, `AdminFullPanel.tsx`, `WorkerFullPanel.tsx`, `WorkersPage.tsx`, `ClientsPage.tsx`, `ActiveLoansPage.tsx`, `OverdueLoansPage.tsx`, `CaixaPage.tsx`, `consolidated-stats.ts`, `worker-utils.ts`.
- **Não tocar**: `loans.remaining_balance`, RPC `apply_loan_payment`/`reverse_loan_payment`, ledger `daily_events`, geração de parcelas, lógica de cravo/renovação.
- **RLS**: mantido — toda agregação por admin/worker passa por `is_super_admin` / `has_role` / `get_admin_id` / `get_worker_id` já existentes.
- **Entrega faseada**: vou pedir aprovação da migration (Fase A) e em seguida aplico B→G numa sequência. Se preferir, posso fatiar em mais turnos (B+C, depois D+E, depois F+G).

Devo seguir? Posso começar pela migration da Fase A e pelas Fases B+C (menus + Dashboard Super Admin) no mesmo turno?
