
# Revisão completa de telas, navegação e organização por role

Objetivo: cada tela com função clara, sem duplicidade, dados corretamente filtrados, navegação previsível e contexto visual sempre presente.

## 1. Mapa de telas final por role

### Trabalhador
Bottom nav: **Rota**, **Geral (Caixa)**
Sidebar: Rota, Geral, Clientes, Empréstimos Ativos, Histórico, Relatórios, Minha Conta
Bloqueado: tudo de admin/super_admin (já protegido por rotas + RLS).

### Admin
Bottom nav: **Painel**, **Caixa Equipe**
Sidebar: Painel (equipe), Trabalhadores, Clientes da Equipe, Empréstimos da Equipe, Caixa da Equipe, Relatórios, Auditoria da Equipe, Manutenção
Acessa rota/caixa de um trabalhador via: Painel → Trabalhador → abas internas.
**Remover** entrada de "Rota" como tela operacional do admin.

### Super Admin
Bottom nav: **Geral (Dashboard)**, **Auditoria**
Sidebar: Dashboard Geral, Administradores, Trabalhadores, Clientes, Empréstimos, Caixa Geral, Relatórios Gerais, **Auditoria Geral**, Manutenção
Acessa equipe/rota via: Dashboard → Administrador → Trabalhador → Rota.

## 2. Diferenciação Dashboard × Auditoria × Manutenção × Relatórios

| Tela | Função | Conteúdo |
|---|---|---|
| **Dashboard Geral** (`/super-admin`) | Visão rápida e gestão | KPIs financeiros (previsto, recebido, falta, líquido, emprestado, retiradas, aportes), contagens (admins/workers/clientes/empréstimos ativos, atrasados, não pagos), alertas, resumo dia/semana/mês, lista de admins clicáveis |
| **Dashboard Admin** (`/admin`) | Gestão da equipe | Mesmos KPIs filtrados pelo admin, lista de trabalhadores clicáveis |
| **Auditoria** (nova `/audit`) | Rastreamento de ações | Tabela de `audit_logs` com filtros: usuário, role, ação, entidade, período, admin, trabalhador, cliente, empréstimo. Mostra old_value/new_value/observação. Sem números financeiros agregados. |
| **Manutenção** (`/admin-tools`) | Ferramentas técnicas | Recalcular installments/loans, atribuir client_codes, verificar vínculos quebrados (clients/loans sem worker/admin), reconciliar caixa. Sem KPIs nem logs. |
| **Relatórios** (`/reports`) | Análise detalhada por período | Filtros dia/semana/mês/personalizado + por admin/trabalhador. Tabelas e gráficos. |

## 3. Mudanças concretas

### Sidebar/Bottom nav (`AppLayout.tsx`)
- Trabalhador: adicionar entrada "Minha Conta" (nova mini tela mostrando login_codigo, troca de senha).
- Admin: bottom nav vira `Painel + Caixa Equipe`; sidebar adiciona "Auditoria da Equipe", "Trabalhadores"; remove `Rota` se existir.
- Super Admin: bottom nav vira `Geral + Auditoria`; sidebar adiciona entrada explícita "Administradores" linkando para `/super-admin` (lista) e separa "Auditoria Geral" → `/audit`.

### Cabeçalho/contexto
- Componente `ScopeIndicator` (já existe) ampliado para sempre mostrar:
  - super_admin sem filtro → "Visão Geral do Sistema"
  - super_admin filtrando admin → "Visualizando Administrador: X"
  - admin → "Equipe de: [nome]"
  - filtro de trabalhador ativo → adiciona "Trabalhador: Y"
- Breadcrumb (já existe) revisado para refletir hierarquia Super Admin > Admin > Trabalhador > [seção].

### Cards
- Card de trabalhador (em listas super_admin): mostrar Admin responsável.
- Card de cliente:
  - super_admin → mostra Admin + Trabalhador
  - admin → mostra Trabalhador
  - trabalhador → não mostra (redundante)
- Card de empréstimo: mesmas regras.

### Agrupamentos
- `ClientsPage`: já tem toggle "agrupar por trabalhador". Adicionar para super_admin um agrupamento extra por administrador (collapse de 2 níveis).
- `ActiveLoansPage`: idem (filtros admin/worker já existem; reorganizar visual em grupos quando habilitado).

### Nova tela Auditoria (`/audit`)
Migrar conteúdo relevante de `AdminPage`/painel para uma página dedicada:
- Tabela paginada de `audit_logs`
- Filtros: período, usuário/role, action_type, entity_type, admin_id, worker_id, client/loan id
- Detalhe expansível com diff old/new
- Acessível para admin (escopo: sua equipe via RLS) e super_admin (todos)

### Manutenção limpa (`/admin-tools`)
Renomear/remover qualquer card que duplique dashboard ou auditoria. Manter:
- Recalcular parcelas (`admin_recalculate_installments`)
- Recalcular empréstimos (`admin_recalculate_loans`)
- Atribuir códigos de cliente
- Verificar registros sem worker_id/admin_id (nova RPC `admin_find_orphans`)
- Reset/sincronização de cash_balance

### Arquivar trabalhador
Já existem RPCs `set_worker_active`, `archive_worker`, `unarchive_worker`. Em `WorkersTab`/`WorkersPage`:
- Trabalhador ativo → botão "Desativar"
- Inativo → botões "Reativar" e "Arquivar"
- Arquivado → botão "Desarquivar"
- Toggle "Mostrar arquivados" (default off) usando `admin_list_workers(p_include_archived := true)`

### Telas vazias por filtro errado — auditoria de queries
Verificar e corrigir:
- `WorkersTab` / `AdminPanelPage` — usar `admin_list_workers()` (já criado)
- `SuperAdminDetailPage` — usar `list_workers_by_admin(p_admin_id)`
- `ClientsPage` quando admin com filtro worker — query inclui `admin_id = X` OR `worker_id = Y` (nunca esconder por falta de admin_id)
- `ActiveLoansPage` — mesma lógica

## 4. Arquivos afetados (estimativa)

- `src/components/AppLayout.tsx` — menus por role
- `src/components/ScopeIndicator.tsx` — labels expandidos
- `src/components/Breadcrumb.tsx` — hierarquia super_admin
- `src/App.tsx` — adicionar rota `/audit` + `/account`
- `src/pages/AuditPage.tsx` *(novo)*
- `src/pages/AccountPage.tsx` *(novo, mini)*
- `src/pages/AdminPage.tsx` — limpar para virar só Manutenção
- `src/pages/SuperAdminPage.tsx` — focar em KPIs + lista de admins
- `src/pages/AdminPanelPage.tsx` — focar em KPIs equipe + lista trabalhadores
- `src/pages/ClientsPage.tsx` — agrupamento 2-níveis super_admin, labels Admin/Trabalhador
- `src/pages/ActiveLoansPage.tsx` — idem
- `src/pages/WorkersPage.tsx` + WorkersTab — fluxo desativar/arquivar/desarquivar com toggle
- Migration: RPC `admin_find_orphans()` e ajustes menores.

## 5. Ordem de execução proposta (3 fases)

**Fase A — Estrutura de navegação (baixo risco)**
1. Reorganizar `AppLayout` (menus + bottom nav por role)
2. Atualizar `ScopeIndicator` e `Breadcrumb`
3. Adicionar rotas `/audit` e `/account`
4. Criar `AuditPage` (lista + filtros básicos) e `AccountPage`

**Fase B — Diferenciação Dashboard / Manutenção**
5. Refatorar `SuperAdminPage` em Dashboard puro (KPIs + cards de admin)
6. Refatorar `AdminPanelPage` em Dashboard da equipe (KPIs + cards de trabalhador)
7. Limpar `AdminPage` (Manutenção) — só ferramentas técnicas
8. Migration: `admin_find_orphans()`

**Fase C — Agrupamentos, cards e arquivar**
9. `ClientsPage` e `ActiveLoansPage`: labels Admin/Trabalhador + agrupamento 2-níveis para super_admin
10. `WorkersPage`/`WorkersTab`: fluxo desativar/arquivar com toggle "mostrar arquivados"

## 6. Critério de aceite

- Bottom nav e sidebar diferentes e coerentes por role
- `/super-admin` mostra KPIs + admins (não logs)
- `/audit` mostra logs (não KPIs)
- `/admin-tools` só ferramentas
- Cards mostram Admin/Trabalhador responsável conforme role
- Trabalhadores arquivados some da lista padrão, com toggle para exibir
- Nenhuma tela "vazia" quando há dados vinculados pela hierarquia

## Pergunta antes de executar

Confirma que posso prosseguir nas **3 fases em sequência** no mesmo turno (ou prefere que eu pare ao fim da Fase A para você validar)?
