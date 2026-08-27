# Port LexisPredict → Offline v5.1.6

Fontes no repo W1CAPITAL/LexisPredict:

| Online (src/lib) | Offline |
|------------------|---------|
| csv-import-engine.ts (aliases RETORNO / PRÓXIMO RETORNO) | parseCsv multilinha + idx M=12 N=13 |
| sanitizeDateCell | parseDate com lixo #VALUE! / ENCERRADO |
| djen.ts plainTextFromDjen | stripHtml + decode |
| djen.ts summarizeDjenKeywords / classifyEventFromText | classifyDjenLp |
| datajud.ts fetchDataJud | queries match/term number |
| Scanner fila carteira | Fila completa com tabela e apply automático |

## Uso
1. Aplicar 1-APLICAR-RECURSOS-NO-EXE.bat (fecha o EXE antes)
2. Plano B → Carregar planilha (obrigatório para M/N)
3. Processos deve mostrar Último e Próx. retorno
4. Scanner → Fila completa

Não é 100% do SaaS (Supabase, CRM, WhatsApp Evolution, cumprimento server-side).
É o núcleo operacional de carteira + tribunal + IA MiniMax.
