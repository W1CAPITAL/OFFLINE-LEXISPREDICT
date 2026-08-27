# A) Diagnóstico do fluxo

| Etapa | Risco | Status 5.1.8 |
|-------|--------|--------------|
| Juntar `.bin` → ZIP | Usar partes erradas (zip isolados) | OK com `Lexis-Offline-parte-XX.bin` + `0b-JUNTAR-PARTES.bat` |
| Injetar `desktop/*` | Pasta do EXE errada | OK se bat achar `Lexis Gabinete.exe` |
| Abrir EXE | JS quebrado = botões mortos | Validado `node --check` |
| Carregar planilha | Cabeçalho multilinha / M/N | Parser multilinha + idx 12/13 |
| Scan | Sem rede = falha | Fila **persistente** grava pending no JSON |
| Push M/N | Sem webhook | Apps Script obrigatório; máx 50 |

# C) Só no Lexis web (não portar agora)

- Supabase multi-tenant / `empresa_id`
- `auditCaseCoreSystem` completo + oportunidade art. 523
- CRM, WhatsApp Evolution, PDF/OCR rico
- UI Next/shadcn
- `created_by` server-side real (aqui só campo local)

# D) Próximo passo (menor risco)

**Não** “Electron abre Next” ainda (exige build + SQLite + CI).  
**Sim** manter shell + fila + push; próximo lib útil: port **somente leitura** de heurísticas de `oportunidade-cumprimento.ts` no applyScan (sem UI CRM).
