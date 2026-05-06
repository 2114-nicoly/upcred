# Plano: 1 Empréstimo Ativo por Cliente + Área do Cliente Profissional

## Objetivo

Cada cliente passa a ter no máximo **1 empréstimo ativo**, a tela do cliente vira o "centro de operação" do empréstimo dele, e o `#código` deixa de aparecer junto ao nome em todas as telas.

---

## 1) Regra: 1 empréstimo ativo por cliente

Considera-se "ativo" qualquer empréstimo com `status != 'paid'` (open/overdue).

**Helper novo** em `src/lib/loan-utils.ts`:
- `getActiveLoanForClient(clientId)` → retorna o empréstimo ativo (ou null).

**Bloqueios aplicados em:**
- `NewLoanSelectClientPage.tsx`: ao clicar num cliente que já tem ativo, mostrar dialog com 3 opções (Abrir ativo / Renovar / Cancelar). Não navegar direto para `/clients/:id/new-loan`.
- `NewLoanPage.tsx`: revalida no `handleSave`. Se já existe ativo e **não é renovação**, bloqueia com toast e oferece navegar ao ativo.
- `ClientDetailPage.tsx`: botão "Novo" só aparece quando não há ativo. Quando há ativo, vira "Renovar".
- Renovação continua permitida (passa por `settleLoan` do antigo dentro do mesmo fluxo, então no momento do insert o antigo ainda é ativo — tratamos isso permitindo o insert quando `renewFromLoanId` está presente E o ativo é exatamente esse loan).

## 2) Remoção dos sufixos `#código` na UI

Remover a renderização de `#{client_code}` em todas as telas, mantendo o campo no banco apenas como ID interno:
- `ClientsPage.tsx` (linha 185)
- `ClientDetailPage.tsx` (linha 156)
- `NewLoanSelectClientPage.tsx` (linha 113)

Busca por código continua funcionando (campo permanece pesquisável internamente).

## 3) Tela do Cliente reorganizada (`ClientDetailPage.tsx`)

Estrutura nova (mantendo o layout mobile-first atual):

```
[ Header limpo: Nome + telefone + notas + botão Editar ]

[ Card "Empréstimo Ativo" ]
  Se existe:
    - Badge status (Em dia / Atrasado N dias)
    - Saldo Restante (destaque grande)
    - Total pago (secundário)
    - Valor da parcela (referência)
    - Progresso fracionado (ex.: 3,5/12) + barra
    - Próximo vencimento
    - Botões: [Pagar] [Renovar] [Ver Detalhes]
  Se não existe:
    - "Nenhum empréstimo ativo"
    - Botão [Criar Empréstimo]

[ Histórico de Empréstimos (collapsible) ]
  Lista de loans com status='paid' ou encerrados:
    - Data início → data quitação
    - Valor total / Total pago
    - Badge: Quitado / Renovado (quando outro loan tem renewed_from_loan_id = este.id)
```

Os botões "Pagar"/"Renovar" navegam para o `LoanDetailPage` e `NewLoanPage?renewFrom=...` já existentes (não duplicar lógica de pagamento aqui).

## 4) Prevenção de duplicidade de cliente

Em `ClientsPage.handleCreate` e `NewLoanSelectClientPage.handleCreateClient`:
- Antes do insert, query: clientes com mesmo `name` (case-insensitive trim) **ou** mesmo `phone` (se preenchido).
- Se encontrar, mostrar dialog "Cliente parecido encontrado: ..." com [Usar existente] [Criar mesmo assim] [Cancelar].

## 5) Detalhes técnicos

- **Sem migrations**: não tornamos a regra "1 ativo" um constraint no banco — fica como regra de aplicação. Justificativa: renovação precisa coexistir brevemente com o antigo durante a transação, e queremos exibir mensagens amigáveis ao usuário em vez de erros do Postgres.
- `client_code` permanece no banco para ordenação determinística e busca; só sai da UI.
- `LoanDetailPage`, `ActiveLoansPage`, `TodayPage` (Rota) já mostram o nome sem prefixo — só auditar e remover se houver algum.

## 6) Arquivos editados

- `src/lib/loan-utils.ts` — adicionar `getActiveLoanForClient`
- `src/pages/ClientsPage.tsx` — remover `#código`, dedupe no create
- `src/pages/ClientDetailPage.tsx` — reorganização total da tela + remover `#código`
- `src/pages/NewLoanSelectClientPage.tsx` — remover `#código`, dialog "já tem ativo", dedupe
- `src/pages/NewLoanPage.tsx` — guard server-side de "1 ativo"

## 7) Validação

- Build (rodado pela harness)
- Manual: criar cliente novo → criar empréstimo → tentar criar outro (deve bloquear) → renovar (deve passar) → tela do cliente mostra ativo+histórico corretamente.

Não mexo em pagamentos, daily_events, parcelas, multa nem layout geral — só na área de cliente/criação e nos rótulos.
