# OFFLINE-LEXISPREDICT

App **Windows (Electron)** da carteira Lexis: processos, fila, scanner DataJud+DJEN, Plano B (planilha) e Assistente IA (MiniMax / Ollama).

> **Não é o LexisPredict web.** O produto online completo está em [W1CAPITAL/LexisPredict](https://github.com/W1CAPITAL/LexisPredict).  
> Este repo é o **EXE + fonte do shell offline** (versão **5.1.7**).

## Limite GitHub (25 MB)

Arquivos grandes do instalador estão em **partes** em `dist-parts/` (cada uma &lt; 20 MB):

| Arquivo | ~tamanho |
|---------|----------|
| `LexisOffline_parte_00.zip` … `_05.zip` | 9–19 MB |

Não versionamos o EXE monólito (~100 MB) nem chaves de API.

## Estrutura

```
OFFLINE-LEXISPREDICT/
├── desktop/                 # FONTE (versionável)
│   ├── main.js              # Electron main: DataJud, DJEN, Sheets CSV, IA
│   ├── preload.js
│   ├── offline.html         # UI completa
│   └── package.json
├── scripts/
│   ├── 0b-JUNTAR-PARTES.bat
│   ├── 1-APLICAR-RECURSOS-NO-EXE.bat
│   └── 2-INSTALAR-OLLAMA-IA.bat
├── dist-parts/              # Partes do pacote com EXE
├── secrets/
│   └── lexis-secrets.example.json
├── docs/
└── README.md
```

## Instalação rápida (Windows)

1. Clone o repo:
   ```bash
   git clone https://github.com/W1CAPITAL/OFFLINE-LEXISPREDICT.git
   cd OFFLINE-LEXISPREDICT
   ```
2. Junte o instalador:
   - Execute `scripts\0b-JUNTAR-PARTES.bat`
   - Extraia `dist-parts\_rebuilt.zip` (gera pasta com `Lexis Gabinete.exe`)
3. Aplique a fonte atual:
   - Execute `scripts\1-APLICAR-RECURSOS-NO-EXE.bat`
   - Informe a pasta do EXE se pedir
4. (Opcional) MiniMax:
   ```bash
   copy secrets\lexis-secrets.example.json secrets\lexis-secrets.json
   ```
   Edite a chave `sk-api-...` e rode o bat de aplicar de novo.
5. Abra **Lexis Gabinete.exe** → deve aparecer **v5.1.7**.
6. **Plano B** → cole o link da planilha Google → **Carregar planilha**.

### Colunas da planilha W1

| Coluna | Campo no app |
|--------|----------------|
| **M** RETORNO | último retorno |
| **N** PRÓXIMO RETORNO | próximo prazo |

## Desenvolvimento

- Edite `desktop/offline.html` e `desktop/main.js`.
- Rode `scripts\1-APLICAR-RECURSOS-NO-EXE.bat` para injetar no EXE empacotado.
- Valide JS: `node --check desktop/main.js` (e extraia o `<script>` do HTML se necessário).

## O que funciona / o que não

| Módulo | Status |
|--------|--------|
| Carteira local + KPIs + fila | OK |
| Import CSV / Google Sheets (export CSV) | OK (leitura) |
| Scanner DataJud + DJEN + aplica prazo | OK (com internet) |
| MiniMax Cloud / Ollama | OK se configurado |
| Escrita automática no Google Sheets | Não (exporte CSV) |
| CRM / cumprimento / Supabase do Lexis web | Não neste shell |

## Relação com LexisPredict

Objetivo de longo prazo: **uma codebase** (Next) + casca Electron.  
Hoje o offline é um **shell operacional** com port parcial (CSV M/N, DJEN, DataJud). Ver `docs/ARQUITETURA.md`.

## Licença

Uso interno W1 Capital / Lexis. Não redistribuir chaves de API.
