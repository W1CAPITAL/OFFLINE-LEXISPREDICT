# Corrigir webhook / “HTTP 200 inesperado” / link que some

## Causa
1. Apps Script implantado como “Só eu” → Google devolve HTML de login (HTTP 200).
2. URL `/dev` em vez de `/exec`, ou URL antiga após editar o código sem **nova versão**.
3. Token diferente do `TOKEN` no script.
4. App gravava campos vazios no `localStorage` ao clicar Sincronizar (apagava o link).

## Deploy certo (2 minutos)
1. Na planilha: Extensões → Apps Script.
2. Apague tudo e cole `apps-script/LEXIS-DB-AppsScript.gs`.
3. `TOKEN = "w1-fase1-2026"` (ou o mesmo do app).
4. Implantar → **Nova implantação** → Aplicativo da web  
   - Executar como: **Eu**  
   - Quem tem acesso: **Qualquer pessoa**
5. Copie a URL que termina em **`/exec`**.
6. No navegador abra essa URL: deve aparecer JSON `{"ok":true,"pong":true,...}`.  
   Se pedir login → acesso ainda está errado.
7. No app: Configurações → cole planilha + webhook + token → **Salvar** → **Testar webhook**.

## Arquivos a copiar no desktop
- `desktop/app.js` (não apaga mais URL no sync)
- `apps-script/LEXIS-DB-AppsScript.gs` (pong + upsert Processos)

## Planilha
- Aba **Processos** com coluna **Protocolo**
- Menu Léxis → Garantir abas
