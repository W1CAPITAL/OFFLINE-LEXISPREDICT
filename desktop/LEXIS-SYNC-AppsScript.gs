/**
 * LEXIS GABINETE — Sincronização 2 vias desktop <-> Google Sheets
 * ===============================================================
 * DEPLOY (1x, leva 2 min):
 *  1. No Google Sheets que é a sua planilha de trabalho, abra:
 *     Extensões -> Apps Script
 *  2. Apague o código padrão e COLE este arquivo inteiro.
 *  3. Troque TOKEN abaixo por uma senha sua (ex: "w1-fase1-2026").
 *     IMPORTANTE: a aba principal da planilha precisa ter cabeçalho
 *     "Protocolo" (o token do CNJ) — use a aba que o Lexis desktop lê.
 *  4. Clique em "Implantar" -> "Nova implantação" ->
 *     Tipo: "Aplicativo da web" -> Executar como: "Eu" ->
 *     Acesso: "Qualquer pessoa" -> Implantar -> Autorizar quando pedir.
 *  5. Copie a URL de implantação (termina em /exec) e cole em:
 *     Lexis desktop -> Configurações -> "URL do webhook" (e coloque o TOKEN).
 * TESTE: abra a URL /exec no navegador -> deve devolver {"ok":true,...}
 */

var TOKEN = "w1-fase1-2026";                 // <<< troque por um token seu
var SHEET_NAME = "Processos";                 // aba principal da carteira
var KEY_COL = "Protocolo";                    // cabeçalho PREFERIDO da coluna-chave (CNJ)
var HEADER_ROW = 1;                           // linha onde estão os cabeçalhos

function norm(s) {
  return String(s || "").replace(/\s+/g, "").replace(/_/g, "").replace(/[^\w\u00C0-\u017F]|_/g, "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function doGet() {
  return out({ ok: true, app: "lexis-gabinete-sync", ts: new Date().toISOString() });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents || "{}");
    if (!body || body.token !== TOKEN) return out({ ok: false, error: "token invalido" });
    if (body.ping) return out({ ok: true, pong: true, app: "lexis-gabinete-sync" });

    var rows = Array.isArray(body.rows) ? body.rows : [];
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];

    var lastCol = Math.max(1, sh.getLastColumn());
    var headers = sh.getRange(HEADER_ROW, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || "").trim(); });
    var keyIdx = -1;
    for (var ci = 0; ci < headers.length; ci++) {
      var hn = norm(headers[ci]);
      if (/protocolo|cnj|processo|numero/.test(hn)) { keyIdx = ci; break; }
    }
    if (keyIdx < 0) return out({ ok: false, error: "coluna-chave (Protocolo/CNJ) nao encontrada no cabecalho" });

    var data = sh.getDataRange().getValues();
    var map = {};
    for (var i = HEADER_ROW + 1; i < data.length; i++) {
      var k = String(data[i][keyIdx] || "").replace(/\D/g, "");
      if (k) map[k] = i + 1;
    }

    var updated = 0, added = 0;
    for (var r = 0; r < rows.length; r++) {
      var rec = rows[r] || {};
      var key = String(rec[KEY_COL] || rec.protocolo || "").replace(/\D/g, "");
      if (!key) continue;
      var row = map[key] || null;
      if (!row) {
        row = sh.getLastRow() + 1;
        var blank = [];
        for (var c = 0; c < sh.getLastColumn(); c++) blank.push("");
        if (blank.length) sh.getRange(row, 1, 1, blank.length).setValues([blank]);
        map[key] = row;
        added++;
      }
      // chave sempre gravada (garante linha certa)
      sh.getRange(row, keyIdx + 1).setValue(rec[KEY_COL] || key);
      updated++;
      // demais campos: casa com o cabeçalho da planilha por nome (sem acento/underscore)
      for (var field in rec) {
        if (norm(field) === norm(KEY_COL)) continue;
        if (rec[field] === undefined || rec[field] === null) continue;
        var val = String(rec[field]);
        if (val === "") continue;
        var fNorm = norm(field);
        for (var c = 0; c < headers.length; c++) {
          if (norm(headers[c]) === fNorm) {
            sh.getRange(row, c + 1).setValue(val);
            break;
          }
        }
      }
    }
    return out({ ok: true, updated: updated, added: added });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}