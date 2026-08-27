# Cópia perfeita do Lexis (Desktop)

## Regra

Uma codebase: **W1CAPITAL/LexisPredict**.  
OFFLINE-LEXISPREDICT = **casca Electron + scripts de build**, não um segundo app.

## Por que offline.html nunca fica igual

- Lexis = Next 15 + dezenas de rotas + Server Actions + Supabase  
- offline.html = 1 arquivo sem CRM, sem cumprimento, sem multi-tenant  

## Fases

1. **Agora** — Electron carrega `next start` do Lexis clonado (UI idêntica online-first no desktop).  
2. **Sheets** — push no save do Lexis (CRM → planilha), compartilhado web+desktop.  
3. **Offline-first** — SQLite/IndexedDB adapter no lugar do Supabase quando sem rede (fila de sync).  
4. **EXE CI** — electron-builder no GitHub Actions, sem `.bin` manuais.

## Caminho do usuário

`C:\Users\USER\Downloads\_extraido\...` = instalador legado.  
Produto alvo = `scripts\2-ABRIR-LEXIS-DESKTOP.bat` após setup.
