# Webhook e planilha — passo a passo (seu caso)

O endpoint **já responde JSON certo** quando testado:
POST → `{"ok":true,"pong":true,"app":"lexis-gabinete-sync"}`

Se o app ainda diz "inesperado HTTP 200", em 99% dos casos é:
A) código novo no editor **sem Nova versão** na implantação
B) planilha **privada** (leitura CSV devolve HTML)
C) app desktop **sem o app.js atualizado**

## 1) Apps Script — NOVA VERSÃO (obrigatório)

Você colou o código, mas a implantação ativa ainda é **Versão 1 (27/08)**.

1. Apps Script → **Implantar → Gerenciar implantações**
2. Clique no **lápis** da implantação ativa
3. Em **Versão** escolha **Nova versão**
4. Quem pode acessar: **Qualquer pessoa**
5. **Implantar**
6. Confirme a URL:
   `https://script.google.com/macros/s/AKfycbxro8UqTJUbFLSOFkpR3unyaBFX_FF-lOVc9_KBcJ8GP-fQmpTzAPRh7a1JLN4ECJMu/exec`

Teste no Chrome (aba anônima):
- Abrir a URL → deve aparecer JSON com `"ok":true`
- Se pedir login → acesso ainda não é "Qualquer pessoa"

## 2) Planilha — compartilhar para LEITURA

A URL de leitura (CSV) **não usa o webhook**. Precisa:

1. Planilha → **Compartilhar**
2. **Qualquer pessoa com o link** → **Leitor**
3. Copiar link (`https://docs.google.com/spreadsheets/d/XXXX/edit?...`)
4. Aba de processos deve ter coluna **Protocolo** (nome exato ou CNJ)

Sem isso o app “carrega” HTML de login e falha.

## 3) No app desktop

1. Configurações
2. **URL da planilha** = link do passo 2
3. **URL do webhook** = `/exec` do passo 1
4. **Token** = `w1-fase1-2026`
5. **Salvar** (importante)
6. **Testar webhook** → tem que aparecer **Webhook OK**
7. **Sincronizar agora**

## 4) Login de usuários (planilha Usuarios)

Login no app **não** é login Google.

- Funciona **local** (JSON) mesmo sem webhook
- Com webhook: precisa aba **Usuarios** + usuários com senha em hash
- Menu Léxis → Criar usuário, ou app → Equipe (superadmin)

Exemplo: `davi` / `Lexis@2026` (se estiver na planilha modelo)

## 5) Se ainda falhar

Troque o `desktop/app.js` pelo do pacote FIX e reaplique o EXE.
No teste de webhook, a mensagem nova mostra o **Raw** da resposta — envie essa linha se precisar de suporte.
