# Pesquisa contínua

# Navegação Admin e Super Admin
- [x] Consolidar acesso às empresas e identificar ações de trabalhadores, acesso e Caixa, sem alterar regras.
- [x] Verificar caminhos autenticados em desktop e celular (360px) nos dois painéis: edição, detalhes, relatórios, acesso, três destinos de Caixa; confirmações de senha e arquivamento canceladas sem alterar dados. Quatro testes de regressão passaram.

# Campos monetários

- [x] Inventariar campos monetários em todos os perfis usando os arquivos atuais (ZIP não disponível nos anexos).
- [x] Padronizar conversão, preenchimento e edição sem alterar campos não monetários ou contratos financeiros.
- [x] Executar testes de conversão, edição e confirmação com RPC simulada; conferir formulário autenticado. Nenhuma operação financeira real criada.
- [ ] Conferir confirmação e estorno com leitura no histórico/relatório em ambiente descartável: bloqueado por falta de ambiente de teste; não movimentar dinheiro real para validar.


- [x] Revisar os campos existentes nos três perfis e identificar causas de perda de foco.
- [x] Corrigir somente Clientes e sua identidade de rota para pesquisa `q`, mantendo os demais filtros e funcionalidades.
- [x] Executar 19 testes e conferir digitação, edição, colagem, limpeza e foco autenticados em Clientes, Ativos, seleção para novo empréstimo, Rota, Lembretes e Auditoria; confirmar persistência da URL sem fechar o modal.

# Editar Trabalhador

- [x] Extrair o modal de edição existente para `WorkerEditDialog` e reusar nas duas listas.
- [x] Botão lápis + "Editar" ao lado do nome em Admin (aba Equipe) e Super Admin (painel da empresa).
- [x] Testes de abertura, preenchimento e salvamento sem sobrescrever observação não lida.
- [x] Conferir logado no celular (360px) e desktop: botão visível, sem rolagem horizontal, modal abre.
