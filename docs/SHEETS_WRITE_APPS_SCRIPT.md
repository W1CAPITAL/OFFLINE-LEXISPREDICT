# Escrita na planilha Google (colunas M / N)

O app **não** grava com o link `/edit` (isso exige OAuth).  
Use um **Google Apps Script** publicado como *Aplicativo da Web*.

## 1. Abrir a planilha

Planilha da carteira (aba com PROTOCOLO, RETORNO, PRÓXIMO RETORNO).

## 2. Extensões → Apps Script

Cole o código abaixo e salve o projeto.

```javascript
/**
 * Lexis Offline — upsert RETORNO (M) e PRÓXIMO RETORNO (N) por PROTOCOLO.
 * Deploy: Implantar → Novo implantacao → Tipo: Aplicativo da web
 * Executar como: Eu | Quem tem acesso: Qualquer pessoa
 * Copie a URL /exec para o campo "Webhook Apps Script" no app.
 */
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents || "{}");
    if (body.action !== "upsertRetornos" || !body.rows || !body.rows.length) {
      return json_({ ok: false, error: "payload invalido" });
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getActiveSheet();
    if (body.sheetGid) {
      var sheets = ss.getSheets();
      for (var s = 0; s < sheets.length; s++) {
        if (String(sheets[s].getSheetId()) === String(body.sheetGid)) {
          sheet = sheets[s];
          break;
        }
      }
    }
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return json_({ ok: false, error: "planilha vazia" });

    var headers = data[0].map(function (h) {
      return String(h || "").toLowerCase().replace(/\s+/g, " ").trim();
    });
    var idxProt = findCol_(headers, ["protocolo", "processo", "cnj"]);
    var idxRet = findCol_(headers, ["retorno", "ultimo retorno", "último retorno"]);
    var idxProx = findCol_(headers, ["próximo retorno", "proximo retorno", "prazo"]);
    var idxObs = findCol_(headers, ["conclusos", "observacao", "observações", "obs"]);

    // Fallback posicional W1: F=5 protocolo, M=12 retorno, N=13 proximo, L=11 conclusos
    if (idxProt < 0) idxProt = 5;
    if (idxRet < 0) idxRet = 12;
    if (idxProx < 0) idxProx = 13;
    if (idxObs < 0) idxObs = 11;

    var indexByProt = {};
    for (var r = 1; r < data.length; r++) {
      var p = String(data[r][idxProt] || "").replace(/\D/g, "");
      if (p) indexByProt[p] = r + 1; // 1-based
    }

    var updated = 0, missing = [];
    body.rows.forEach(function (row) {
      var digits = String(row.protocolo || "").replace(/\D/g, "");
      if (!digits || !indexByProt[digits]) {
        missing.push(row.protocolo || digits);
        return;
      }
      var rowNum = indexByProt[digits];
      if (row.ultimo) sheet.getRange(rowNum, idxRet + 1).setValue(row.ultimo);
      if (row.prazo) sheet.getRange(rowNum, idxProx + 1).setValue(row.prazo);
      if (row.obs && idxObs >= 0) sheet.getRange(rowNum, idxObs + 1).setValue(row.obs);
      updated++;
    });

    return json_({ ok: true, updated: updated, missing: missing });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doGet() {
  return json_({ ok: true, service: "lexis-offline-sheets", version: 1 });
}

function findCol_(headers, names) {
  for (var i = 0; i < headers.length; i++) {
    for (var j = 0; j < names.length; j++) {
      if (headers[i].indexOf(names[j]) >= 0) return i;
    }
  }
  return -1;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
```

## 3. Implantar

1. **Implantar** → **Nova implantação**
2. Tipo: **Aplicativo da web**
3. Executar como: **Eu**
4. Quem tem acesso: **Qualquer pessoa** (ou contas da organização)
5. Copiar a URL que termina em `/exec`

## 4. No Lexis Offline

1. **Plano B** → colar URL no campo **Webhook Apps Script**
2. Carregar planilha (leitura)
3. Escanear / editar retornos
4. **Enviar retornos → planilha (M/N)**

Limite por envio: 50 linhas (Apps Script).

## Segurança

A URL do webhook é um segredo operacional. Não publique em repositório público.  
Para produção, restrinja o acesso às contas Google da banca.
