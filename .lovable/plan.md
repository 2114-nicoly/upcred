## Objetivo

Garantir que Super Admin, Admin e Trabalhador vejam exatamente os dados certos, com vínculos corretos (`worker_id`, `admin_id`), agrupamento por responsável, e remoção de telas duplicadas/vazias.

## Diagnóstico atual

Pelo código e schema:
- **Triggers `auto_set_worker_id` / `auto_set_admin_id` existem** mas não estão registrados como triggers ativos no banco (a seção `<db-triggers>` está vazia). Isso explica clientes/loans criados sem vínculo.
- **`ClientsPage.handleCreate`** insere cliente sem `worker_id`/`admin_id` quando o admin está com filtro de trabalhador ativo — ou seja, o admin não consegue criar cliente "para um trabalhador".
- **`AdminPanelPage` / equipe**: provavelmente usa `admin_list_workers` que já existe; precisa validar que retorna dados.
- **Hierarquia visual** (breadcrumb de escopo) não está consistente entre telas.

## Mudanças

### 1. Banco — vínculos automáticos garantidos
Criar migração que:
- Reaplica triggers `BEFORE INSERT` em `clients`, `loans`, `daily_events`, `cash_movements`, `not_paid_marks`, `penalties` chamando `auto_set_worker_id` + `auto_set_admin_id`.
- Adiciona trigger `loans_inherit_from_client` que, no INSERT de loan, copia `worker_id`/`admin_id` do `client` se não informados.
- Backfill: UPDATE em `clients`, `loans`, `daily_events`, `cash_movements` preenchendo `admin_id` a partir de `worker.parent_admin_id` quando NULL.
- Nova RPC `admin_create_client(p_name, p_phone, p_notes, p_worker_id)` que valida que o worker pertence ao admin (ou super_admin) e insere com vínculos corretos.

### 2. Frontend — criação de cliente com worker selecionado

**`ClientsPage.tsx`**:
- Adicionar campo "Trabalhador responsável" no diálogo de novo cliente quando o usuário é admin/super_admin.
- Pré-selecionar com `selectedWorkerId` do filtro hierárquico.
- Bloquear criação sem worker quando admin/super_admin.
- Usar nova RPC `admin_create_client`.

**`ClientDetailPage` / criação inline**: mesma regra.

### 3. Equipe — Admin e Super Admin

**`AdminPanelPage.tsx`** (Admin → Equipe):
- Garantir que usa `admin_list_workers()` e mostra estado vazio com botão "Criar trabalhador" quando lista vazia.
- Para cada trabalhador: clientes ativos, empréstimos ativos, recebido hoje, atrasados — via RPC nova `admin_team_stats()` ou agregação client-side.

**`SuperAdminDetailPage.tsx`** (Super Admin → Admin selecionado):
- Mostrar equipe daquele admin via `list_workers_by_admin(p_admin_id)`.
- Estado vazio claro com CTA.

### 4. Agrupamento de clientes/empréstimos
- `ClientsPage` já tem toggle "Agrupar por trabalhador". Garantir que aparece label do trabalhador/admin responsável em cada card mesmo sem agrupamento (já tem).
- `ActiveLoansPage`, `OverdueLoansPage`: idem (já implementado em Fase F).

### 5. Indicador de escopo (`ScopeIndicator`)
- Garantir que aparece no topo das telas Clientes, Empréstimos, Caixa, Rota, Relatórios mostrando: "Visão: Geral / Admin: X / Trabalhador: Y".

### 6. Limpeza de telas
Identificar e esconder/remover do menu:
- Páginas duplicadas (ex.: `DailyCashPage` vs `CaixaPage` vs `DailyCashHistoryPage` vs `CashHistoryPage`) — manter apenas `CaixaPage` + `CashHistoryPage`.
- Confirmar antes de deletar.

## Detalhes técnicos (resumo)

- Migração SQL com triggers + backfill + RPC nova.
- RLS já cobre o cenário (políticas `Scoped access` em todas as tabelas) — não mexer.
- Nenhuma alteração de lógica financeira (`remaining_balance`, `apply_loan_payment`, `reverse_loan_payment` permanecem).

## Pergunta antes de executar

Esse trabalho é grande (DB + várias telas + limpeza de menu). Posso começar pelas **partes 1+2 (vínculos automáticos + admin cria cliente para trabalhador)**, que resolvem o problema central que você descreveu? As outras partes (limpeza de menu, stats por trabalhador na equipe) eu faço em sequência depois que você confirmar que o vínculo está funcionando.

Confirma esse plano em fases ou prefere que eu faça tudo de uma vez (resposta mais demorada e maior risco de erro)?
