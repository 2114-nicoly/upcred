# Parte 2 — Sistema de Acesso Profissional (super_admin / admin / trabalhador)

A Parte 1 (hierarquia, RLS, painel super_admin, filtros) já está em produção. Esta parte foca em **cadastro real com Supabase Auth, credenciais, login, recuperação e e-mail**.

## 1. Banco de dados (1 migração consolidada)

### Ajustes em `admins` e `workers`
- `admins.notas TEXT`, `admins.temporary_password BOOLEAN DEFAULT true`
- `workers.temporary_password BOOLEAN DEFAULT true`
- `profiles.role` permanece via `user_roles` (mantém arquitetura).

### Nova tabela `user_credentials_log`
Campos: `id`, `auth_user_id`, `nome`, `role` (admin/trabalhador), `login_codigo`, `senha_temporaria` (texto, apagada após primeiro login), `created_by`, `admin_id`, `created_at`, `viewed_at`, `status` (`pending`, `viewed`, `consumed`, `revoked`).

RLS:
- super_admin: tudo
- admin: apenas registros onde `created_by = auth.uid()` ou `admin_id = get_admin_id(auth.uid())`
- trabalhador: nenhum acesso

### Nova tabela `password_recovery_requests`
Campos: `id`, `login_informado`, `nome_informado`, `email_informado`, `target_user_id`, `target_role`, `target_admin_id`, `status` (`open`/`resolved`/`rejected`), `requested_at`, `resolved_at`, `resolved_by`, `notas`.

RLS: insert público (sem auth), select restrito a super_admin (todos) e admin (se `target_admin_id = get_admin_id(auth.uid())`).

### Funções/RPCs novas
- `generate_admin_login_codigo()` → 5 dígitos único
- `generate_worker_login_codigo()` → 4 dígitos único
- `super_admin_reset_admin_password(p_admin_id)` → marca `temporary_password=true` (senha real é setada na edge function)
- `admin_reset_worker_password(p_worker_id)` → idem
- `consume_credential(p_log_id)` → marca log como consumed e apaga `senha_temporaria`
- `register_recovery_request(...)` → insert público
- `resolve_recovery_request(p_id, p_status, p_notas)` → admin/super_admin

Trigger `handle_new_user` ajustado: se email = `nicknicoly2114@gmail.com`, role = `super_admin`.

## 2. Edge Functions (Supabase Auth via service role)

Como o front não pode criar usuários no Auth, usaremos 4 edge functions com `service_role`:

- **`admin-create-admin`**: super_admin cria admin. Gera login 5 dígitos + senha 8 dígitos, cria user no Auth com email real, insere em `admins`, `user_roles`, `user_credentials_log`. Retorna credenciais.
- **`admin-create-worker`**: admin/super_admin cria trabalhador. Gera login 4 dígitos + senha 8 dígitos, cria user no Auth com `worker_<codigo>@upcred.local`, insere em `workers`, `user_roles`, `user_credentials_log`. Para super_admin, aceita `parent_admin_id` no body.
- **`admin-reset-password`**: gera nova senha 8 dígitos, atualiza no Auth, registra log. Permissões respeitando hierarquia.
- **`admin-toggle-active`**: ativa/desativa user (banUntil no Auth + flag active). Já temos parcial, vamos consolidar.
- **`auth-resolve-login`**: dado `login` (4, 5 dígitos ou email), retorna o email a ser usado no `signInWithPassword`. Público.
- **`send-credentials-email`** (opcional, só roda se domínio configurado): envia para email real do admin responsável + nicknicoly2114@gmail.com. Falha silenciosa.

Todas as funções de criação/reset registram em `audit_logs` via `log_audit`.

## 3. Frontend

### Login (`/auth`)
- Tela única e simples: campo **Login** (aceita email, 4 ou 5 dígitos), campo **Senha**, botão **Entrar**, link **Esqueci login ou senha**.
- Fluxo: chamar `auth-resolve-login` → receber email → `signInWithPassword(email, senha)`.

### Painel Super Admin → aba **Administradores** (já existe)
- Botão **Criar administrador**: form com nome, email real, observação. Ao submeter, chama `admin-create-admin`. Mostra `<CredentialsDialog>` com nome/role/login/senha + botão copiar.
- Lista admins com ações: Ver detalhes, Resetar senha, Ativar/Desativar.

### Painel Admin → nova rota `/admin/trabalhadores`
- CRUD de trabalhadores da própria equipe usando `admin-create-worker`/`admin-reset-password`.
- Super admin vê este painel também, com seletor de equipe.

### Componente `CredentialsDialog`
- Mostra credenciais geradas com botão copiar e aviso de guardar.

### Página `/recuperar-acesso`
- Form simples com nome/login/email opcionais → insere em `password_recovery_requests`.
- Mensagem genérica de sucesso (sem expor dados).

### Painel admin/super_admin → nova aba **Solicitações de acesso**
- Lista `password_recovery_requests` abertas, com botão **Resolver** (gera nova senha via `admin-reset-password`).

### Painel admin/super_admin → nova aba **Log de Credenciais**
- Mostra `user_credentials_log` com filtros, escopo conforme RLS.

### Cabeçalho (`AppLayout`)
- Já mostra nome/role/badge. Garantir badge visual super_admin (Crown — já existe) e indicador do filtro ativo.

## 4. Segurança / RLS
- Mantemos RLS já criada na Parte 1. Apenas adicionamos políticas para as novas tabelas.
- Todas as edge functions validam `auth.uid()` + role do chamador antes de criar/modificar.
- Bloqueio de login para inativo: edge function `auth-resolve-login` checa `active=true` antes de devolver email; também checamos no front após login.

## 5. Auditoria
Cada edge function chama `log_audit(...)` com tipo apropriado: `criar_admin`, `criar_trabalhador`, `redefinir_senha`, `recuperacao_solicitada`, `ativar_usuario`, `desativar_usuario`.

## 6. E-mail (opcional, não bloqueia criação)
- Verificar se Lovable Email está configurado. Se sim, scaffold `send-transactional-email` com 2 templates: `credentials-issued` e `credentials-reset`.
- Caso não esteja configurado, edge function de criação simplesmente pula o envio.
- Para esta entrega: implementar a estrutura mas deixar e-mail desligado se não houver domínio. Sugerir setup ao final.

## 7. Não-regressão
Não tocamos em: lógica de pagamento, parcelas, `remaining_balance`, Rota, Geral, Relatórios, Renovação, Auditoria financeira, regra de 1 empréstimo ativo. Apenas adicionamos camadas.

## Entrega faseada
1. **DB**: migração com tabelas, colunas, funções, RLS, trigger super_admin.
2. **Edge functions**: 5 funções (sem e-mail por enquanto).
3. **Front**: login novo, CredentialsDialog, criação de admin (super), criação de trabalhador (admin/super), reset senha, ativar/desativar.
4. **Recuperação**: página pública + aba de resolução.
5. **Log de credenciais**: aba.
6. **E-mail** (se domínio existir): templates + integração nas edge functions.

Confirma que posso prosseguir com tudo nesta ordem?
