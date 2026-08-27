# Arquitetura OFFLINE-LEXISPREDICT

## O que este repo é
App **Electron** (Lexis Gabinete.exe) + **fonte UI** (`desktop/offline.html`) + **main process** (`desktop/main.js`).

Não substitui o [LexisPredict](https://github.com/W1CAPITAL/LexisPredict) (Next.js + Supabase). É o modo **carteira + scanner + IA** no PC.

## Diagrama
```
desktop/offline.html  → UI (carteira, fila, scanner, Plano B, IA)
desktop/preload.js    → bridge IPC seguro
desktop/main.js       → DataJud, DJEN, fetch planilha CSV, MiniMax/Ollama, save local
dist-parts/*.zip      → partes do EXE (< 25 MB cada, limite GitHub web)
```

## Online vs offline
| Função | Offline | Rede |
|--------|---------|------|
| Ver/editar carteira local | Sim | — |
| Import planilha (CSV/Sheets export) | Sim | Leitura |
| DataJud + DJEN | Não | Obrigatório |
| MiniMax | Não | Obrigatório |
| Ollama local | Sim | — |

## Paridade com LexisPredict
Port parcial: aliases CSV M/N, classificação DJEN, queries DataJud, fila de scan.
Não portado: CRM multi-tenant, cumprimento server-side, Supabase, Evolution WhatsApp.
