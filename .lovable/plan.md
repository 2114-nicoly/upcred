# 📋 App de Controle de Empréstimos

## Visão Geral

Aplicativo moderno e colorido para gerenciar empréstimos pessoais, com cadastro de clientes, controle de parcelas, registro de pagamentos e visão diária de cobranças.

---

## 🗄️ Banco de Dados (Supabase)

Tabelas para armazenar clientes, empréstimos, parcelas e pagamentos de forma segura na nuvem.

---

## 📱 Telas e Funcionalidades

### 1. Tela "Hoje" (Página Inicial)

- Lista todas as parcelas que vencem no dia atual
- Cada parcela mostra: nome do cliente, valor, número da parcela
- Indicador visual de status (em dia, atrasado)
- Botões rápidos: **"Registrar Pagamento"** e **"Não Pagou"** em cada parcela
- Resumo do dia: total a receber, total recebido, quantidade de cobranças

### 2. Cadastro de Clientes

- Formulário com nome, telefone e observações
- Lista de clientes com busca por nome
- Ao clicar no cliente, abre a tela com seus empréstimos ativos

### 3. Tela do Cliente (Empréstimos)

- Lista de empréstimos **ativos** com status colorido (🟢 em dia, 🔴 atrasado)
- Seção de **Histórico** para empréstimos quitados (ocultos por padrão, expansível)
- Botão para criar novo empréstimo

### 4. Novo Empréstimo

- Formulário com:
  - Valor emprestado
  - Tipo de juros para selecionar: porcentagem (%) ou valor fixo (R$) e depois digitar respectivamente 
  - Quantidade de parcelas
  - Tipo de pagamento selecionar: diário, semanal, quinzenal, mensal ou data fixa
  - Data do empréstimo 
  - Data do primeiro vencimento se nao for do tipo data fixa
  - Se for do tipo data fixa ai colocar pra eu preencher as datas de vencimento de cada parcela, de acordo com a quantidade de parcelas que eu colocar que vai ser
- **Cálculo automático** exibido em tempo real:
  - Valor final (emprestado + juros)
  - Valor de cada parcela
  - Datas de vencimento previstas Para as parcelas subsequentes se houver, a partir da data de vencimento da primeira parcela digitada, caso nao for do tipo data fixa

### 5. Detalhes do Empréstimo

- Informações gerais: valor emprestado, juros, valor final, status
- Barra de progresso visual do pagamento, mostrando a quatidade de parcelas pagas e o total que é
- Saldo restante em destaque
- Lista de todas as parcelas com:
  - Número, valor, data de vencimento previsto, status (paga/pendente/atrasada)
  - Botão **"Registrar Pagamento"** e **"Não Pagou"**
- Opção de **adicionar multa** em parcelas individuais
  - Multas acumulam em uma parcela extra adicionada ao final
- Status do empréstimo: **Em Aberto**, **Atrasado** ou **Quitado**

### 6. Registro de Pagamento

- Ao clicar em "Registrar Pagamento": registra o valor da parcela como pago, atualiza saldo e progresso
- Ao clicar em "Não Pagou": marca a parcela como atrasada

7 Quero uma area de dias que mostre separado por dias, ai clicando no dia mostre todas parcelas que pagaram naquele dia. Sendo que todas as parcelas tem que mostrar ao qual emprestimo de qual cliente pertencem

---

## 🎨 Design

- Visual moderno e colorido com cards destacados
- Cores para status: verde (em dia/quitado), amarelo (hoje), vermelho (atrasado)
- Layout responsivo para uso em celular e desktop
- Navegação simples entre as telas via menu inferior ou lateral