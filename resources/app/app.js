/* Lexis Gabinete v6.0 — renderer (app.js)
 * Port das regras do LexisPredict (repo W1CAPITAL): prazo-status, fila-prioridade,
 * dashboard-metrics, status-encerrado. Dados = Google Sheets (leitura via CSV,
 * escrita via Apps Script webhook). Offline-first com outbox de pendências.
 */
(function () {
  "use strict";
  if (!document.getElementById || document.getElementById("toast") === null) return;

  var rows = [];
  var notes = [];
  var outbox = []; // {protocolo, row:{...}, ts}
  var colMap = {}; // campo -> cabeçalho real da planilha
  var lastDiag = null;
  var editId = null;

  var LS = { url: "lexis_g_sheets_url", web: "lexis_g_webhook", tok: "lexis_g_token", oper: "lexis_g_oper", theme: "lexis_g_theme" };
  var cfg = { url: "", webhook: "", token: "", oper: "" };
  var lastSync = "";

  var TITLES = {
    dashboard: ["Painel da carteira", "Visão geral"],
    fila: ["Fila de atendimento", "Prioridades e prazos"],
    casos: ["Meus processos", "Carteira do gabinete"],
    processos: ["Processos da empresa", "Todas as carteiras"],
    parados: ["Processos parados", "Sem andamento há 60+ dias"],
    encerrados: ["Encerrados a revisar", "Filtro humano"],
    import: ["Importar", "Planilha · CSV · arquivo"],
    agenda: ["Agenda", "Próximos retornos · 7 dias"],
    dossie: ["Dossiê operacional", "Relatório da carteira"],
    veredito: ["Veredito", "Consulta DataJud + DJEN"],
    scanner: ["Scanner Omnipresente", "Varredura DataJud + DJEN · logs"],
    notas: ["Notas", "Anotações internas"],
    cadastro: ["Cadastro", "Novos processos · importação manual"],
    config: ["Configurações", "Vínculo com a planilha"]
  };

  /* ============================ helpers ============================ */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  var toastT = null;
  function toast(msg, cls) {
    var t = $("toast");
    t.textContent = msg;
    t.className = "toast show" + (cls ? " " + cls : "");
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.className = "toast"; }, 3200);
  }
  function hojeBR() {
    var p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    var o = {};
    p.forEach(function (x) { o[x.type] = x.value; });
    return o.year + "-" + o.month + "-" + o.day;
  }
  function onlyDigits(s) { return String(s || "").replace(/\D/g, ""); }
  function formatCnj(d) {
    d = onlyDigits(d);
    if (d.length !== 20) return d;
    return d.slice(0, 7) + "-" + d.slice(7, 9) + "." + d.slice(9, 13) + "." + d.slice(13, 14) + "." + d.slice(14, 16) + "." + d.slice(16);
  }
  function normHeader(s) {
    return String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  }
  function parseDate(s) {
    if (s == null) return null;
    s = String(s).trim();
    if (!s) return null;
    if (/^#/.test(s) || /^[-–—]+$/.test(s) || /^(encerrado|finalizado|s\/p|s\/prazo|n\/a|zero|sem prazo|semprazo|senten[çc]a|pronto|ok)$/i.test(s)) return null;
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})([T ]|$)/);
    if (m) return m[1] + "-" + m[2] + "-" + m[3];
    m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})([\sT]|$)/);
    if (m) {
      var y = m[3].length === 2 ? "20" + m[3] : m[3];
      return y + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[1]).slice(-2);
    }
    if (/^\d{4,5}(\.\d+)?$/.test(s)) {
      var num = parseFloat(s);
      if (num >= 20000 && num <= 60000) {
        var d = new Date(Date.UTC(1899, 11, 30) + num * 86400000);
        if (!isNaN(d.getTime())) {
          var z = function (n) { return n < 10 ? "0" + n : "" + n; };
          return d.getUTCFullYear() + "-" + z(d.getUTCMonth() + 1) + "-" + z(d.getUTCDate());
        }
      }
    }
    return null;
  }
  function diasAte(prazo) {
    if (!prazo) return null;
    var a = new Date(prazo + "T12:00:00");
    var b = new Date(hojeBR() + "T12:00:00");
    var dd = Math.round((a - b) / 86400000);
    return isNaN(dd) ? null : dd;
  }
  function diasDesde(iso) {
    if (!iso) return null;
    var a = new Date(iso + "T12:00:00");
    var b = new Date(hojeBR() + "T12:00:00");
    var dd = Math.round((b - a) / 86400000);
    return isNaN(dd) ? null : dd;
  }
  function isAtendimentoRecente(ultimoRetorno, horas) {
    horas = horas || 36;
    if (!ultimoRetorno) return false;
    var d = new Date(ultimoRetorno + "T12:00:00");
    if (isNaN(d.getTime())) return false;
    return (new Date() - d) < horas * 3600000;
  }

  /* ============================ lógica pouco-própria (port do repo) ============================ */
  function hasStrongEncerrado(c) {
    var blob = [c.situacao, c.statusManual, c.observacao].join(" | ").toUpperCase();
    return /ENCERRAD|ARQUIVAD|EXTINT|SUSPENS|FINALIZAD|BAIXA DEFINITIVA|ARQUIVAMENT/.test(blob);
  }
  function statusDe(c) {
    if (c.statusManual === "Encerrado" || c.statusManual === "Arquivado") return "Arquivado";
    if (c.statusManual === "Caso Crítico") return "Caso Crítico";
    if (c.datajud_encerrado_tribunal || hasStrongEncerrado(c)) return "Arquivado";
    var d = diasAte(c.proximoPrazo);
    if (d === null) return "Sem Prazo";
    if (d < 0) return "Vencido";
    if (d === 0) return "É Hoje";
    if (d <= 3) return "Atenção";
    return "No Prazo";
  }
  function isBaixaTribunal(c) { return !!c.datajud_encerrado_tribunal; }
  function pesoFila(c) {
    var w = 0;
    var st = statusDe(c);
    if (isBaixaTribunal(c)) w += 980;
    if (c.is_improcedente) w += 900;
    if (c.is_procedente) w += 860;
    var ev = (c.evento_resumo || "").toLowerCase();
    if (/improcedente/.test(ev)) w += 900;
    else if (/procedente/.test(ev)) w += 860;
    if (/cumprimento/.test(ev)) w += 680;
    if (/audienc/.test(ev)) w += 740;
    if (c.tem_novo_andamento || c.djen_nova_comunicacao) w += 420;
    if (st === "Caso Crítico") w += 380;
    else if (st === "Vencido") w += 320;
    else if (st === "É Hoje") w += 280;
    else if (st === "Atenção") w += 140;
    if (!onlyDigits(c.telefone)) w += 40;
    var obs = (c.observacao || "").toUpperCase();
    if (/BLACKLIST/.test(obs)) w -= 2000;
    if (/TRATAMENTO/.test(obs)) w -= 600;
    if (isAtendimentoRecente(c.ultimoRetorno)) w -= 800;
    return Math.max(0, w);
  }
  function faixaPrioridade(w) {
    if (w >= 1200) return ["Crítica", "b-crit"];
    if (w >= 750) return ["Alta", "b-ven"];
    if (w >= 450) return ["Média", "b-aten"];
    if (w >= 250) return ["Baixa", "b-ok"];
    return ["Rotina", "b-sem"];
  }
  function badge(st) {
    if (st === "Vencido") return '<span class="badge b-ven">Vencido</span>';
    if (st === "Caso Crítico") return '<span class="badge b-crit">Crítico</span>';
    if (st === "É Hoje") return '<span class="badge b-hoje">É hoje</span>';
    if (st === "Atenção") return '<span class="badge b-aten">Atenção</span>';
    if (st === "No Prazo") return '<span class="badge b-ok">No prazo</span>';
    if (st === "Sem Prazo") return '<span class="badge b-sem">Sem prazo</span>';
    if (st === "Arquivado") return '<span class="badge b-arq">Arquivado</span>';
    return '<span class="badge b-arq">' + esc(st) + "</span>";
  }
  function kpisAll() {
    var k = { total: rows.length, ativos: 0, venc: 0, hoje: 0, aten: 0, seguro: 0, sem: 0, arq: 0, nov: 0, baixa: 0, improc: 0, proc: 0, atendidosHoje: 0 };
    rows.forEach(function (c) {
      var st = statusDe(c);
      if (st === "Arquivado") { k.arq++; return; }
      k.ativos++;
      if (st === "Vencido" || st === "Caso Crítico") k.venc++;
      else if (st === "É Hoje") k.hoje++;
      else if (st === "Atenção") k.aten++;
      else if (st === "Sem Prazo") k.sem++;
      else k.seguro++;
      if (c.tem_novo_andamento || c.djen_nova_comunicacao) k.nov++;
      if (c.datajud_encerrado_tribunal) k.baixa++;
      if (c.is_improcedente) k.improc++;
      if (c.is_procedente) k.proc++;
      if (c.ultimoRetorno === hojeBR()) k.atendidosHoje++;
    });
    return k;
  }
  function computeRisk(k) {
    if (!k.ativos) return { score: 0, label: "BAIXO", color: "#10b981", fatores: [] };
    var soma = 0;
    soma += (k.venc) * 1.0;
    soma += (k.baixa + k.improc) * 0.0;
    soma += k.baixa * 0.55 + k.improc * 0.55;
    soma += k.hoje * 0.8;
    soma += k.aten * 0.5;
    soma += k.nov * 0.25;
    soma += k.sem * 0.2;
    soma += k.seguro * 0.08;
    soma += k.baixa * 0.15;
    var score = Math.min(100, Math.round((soma / k.ativos) * 100));
    var label = score < 20 ? "BAIXO" : score < 40 ? "MODERADO" : score < 60 ? "ELEVADO" : score < 80 ? "ALTO" : "CRÍTICO";
    var color = score < 20 ? "#10b981" : score < 40 ? "#84cc16" : score < 60 ? "#f97316" : score < 80 ? "#ef4444" : "#b91c1c";
    var fatores = [];
    if (k.venc) fatores.push([k.venc + " vencido(s)", "#ef4444"]);
    if (k.hoje) fatores.push([k.hoje + " é hoje", "#3b82f6"]);
    if (k.aten) fatores.push([k.aten + " atenção", "#f97316"]);
    if (k.sem) fatores.push([k.sem + " sem prazo", "#94a3b8"]);
    if (k.nov) fatores.push([k.nov + " novidade(s)", "#a855f7"]);
    return { score: score, label: label, color: color, fatores: fatores.slice(0, 5) };
  }
  function sortByPriority(list) {
    return list.slice().sort(function (a, b) { return pesoFila(b) - pesoFila(a); });
  }
  function filtroAtivos(list) { return list.filter(function (c) { return statusDe(c) !== "Arquivado"; }); }

  /* ============================ CSV / planilha ============================ */
  function csvRows(text) {
    text = String(text || "");
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var semi = 0, comma = 0;
    for (var k = 0; k < text.length; k++) {
      var ch0 = text[k];
      if (ch0 === ",") comma++;
      else if (ch0 === ";") semi++;
    }
    var sep = semi > comma ? ";" : ",";
    var rows = [], row = [], cell = "", inQ = false, i = 0, n = text.length;
    function pushCell() { row.push(cell); cell = ""; }
    function pushRow() {
      if (cell !== "" || row.length) { pushCell(); rows.push(row); }
      row = [];
    }
    while (i < n) {
      var ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        cell += ch; i++; continue;
      }
      if (ch === '"' && cell.trim() === "") { inQ = true; i++; continue; }
      if (ch === sep) { pushCell(); i++; continue; }
      if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        pushRow(); i++; continue;
      }
      cell += ch; i++;
    }
    pushRow();
    var clean = rows.filter(function (r) {
      return r.some(function (c) { return String(c).trim() !== ""; });
    });
    return clean;
  }
  function detectHeaderLine(rows) {
    var best = 0, bestScore = 0;
    for (var i = 0; i < Math.min(rows.length, 8); i++) {
      var cells = (rows[i] || []).map(function (h) { return normHeader(h); });
      var joined = (rows[i] || []).join(" ");
      if (/\+?\d{10,13}|\d{3,4}[-. ]?\d{3,4}[-. ]?\d{3,4}/.test(joined)) continue;
      var score = 0;
      cells.forEach(function (c) {
        if (/cliente|nome|parte|autor|razao/.test(c)) score += 3;
        if (/protocolo|processo|cnj|numero/.test(c)) score += 3;
        if (/retorno|prazo|contato|situac|status|telefone|obs|operador|andamento/.test(c)) score += 1;
      });
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }
  function colName(i) {
    var s = "", n = i + 1;
    while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  function pick(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (obj[k] != null && String(obj[k]).trim() !== "") return String(obj[k]).trim();
      var kn = normHeader(k);
      for (var p in obj) {
        if (normHeader(p) === kn && obj[p] != null && String(obj[p]).trim() !== "")
          return String(obj[p]).trim();
      }
    }
    return "";
  }
  function parseCsv(text) {
    var rows = csvRows(text);
    if (rows.length < 2) return [];
    var hi = detectHeaderLine(rows);
    var headers = (rows[hi] || []).map(function (h) { return String(h).trim(); });
    var nh = headers.map(normHeader);
    function exactA(alias) {
      for (var c = 0; c < nh.length; c++) if (nh[c] === alias) return c;
      return -1;
    }
    function colA(aliases) {
      for (var i = 0; i < aliases.length; i++) {
        var e = exactA(aliases[i]);
        if (e !== -1) return e;
      }
      for (var c = 0; c < nh.length; c++)
        for (var j = 0; j < aliases.length; j++)
          if (aliases[j].length >= 4 && nh[c].indexOf(aliases[j]) === 0) return c;
      return -1;
    }
    var iR = colA(["retorno", "ultimo", "ultimoretorno", "retornofeito", "retornoanterior", "dataultimoretorno"]);
    var iP = colA(["proximoretorno", "proxretorno", "proximoprazo", "dataproximoretorno", "retornocliente", "proximocontato", "prazo"]);
    var out = [];
    for (var i = hi + 1; i < rows.length; i++) {
      var cols = rows[i] || [];
      var pk = function (keys) {
        for (var q = 0; q < keys.length; q++)
          for (var x = 0; x < nh.length; x++)
            if (nh[x] === normHeader(keys[q])) {
              var vv = cols[x] != null ? String(cols[x]).trim() : "";
              if (vv) return vv;
            }
        return "";
      };
      var cliente = pk(["cliente", "nome", "parte", "autor", "nomecliente", "razaosocial", "clientenome", "consumidor"]);
      var protocolo = pk(["protocolo", "cnj", "processo", "numero", "nprocesso", "protocoloref", "numeroprocesso", "numprocesso"]);
      if (!cliente && !protocolo) continue;
      var cell = function (x) { return x >= 0 && cols[x] != null ? String(cols[x]).trim() : ""; };
      var rawRetorno = pk(["ultimo", "ultimoretorno", "retornoanterior", "retornofeito", "dataultimoretorno"]) || cell(iR);
      var rawProximo = pk(["proximoretorno", "proxretorno", "proximoprazo", "dataproximoretorno", "proximocontato", "retornocliente"]) || cell(iP);
      var ultimoRetorno = parseDate(rawRetorno);
      var proximoPrazo = parseDate(rawProximo);
      var situacao = pk(["situacao", "status", "andamento", "conclusos", "fase", "estado", "st"]);
      var outC = {
        id: onlyDigits(protocolo) || "r" + i + "_" + Math.random().toString(36).slice(2, 7),
        protocolo: protocolo,
        cliente: cliente,
        telefone: pk(["telefone", "celular", "whatsapp", "fone", "tel", "movel"]),
        cpf: pk(["cpf", "cnpj", "doc", "documento", "cpfcliente"]),
        email: pk(["email", "emailcliente"]),
        tribunal: pk(["tribunal", "vara", "comarca", "foro", "tribunaljustica"]),
        advogado: pk(["advogado", "adv", "responsavel"]),
        escritorio: pk(["escritorio", "unidade"]),
        assistente: pk(["assistente", "atendente", "operador"]),
        situacao: situacao,
        ultimoRetorno: ultimoRetorno,
        proximoPrazo: proximoPrazo,
        observacao: pk(["obs", "observacao", "observacoes", "notas", "anotacoes", "comentario"]),
        statusManual: "Automatico",
        arquivado: false,
        origem: "sheet"
      };
      var dm = pk(["datamovimentacao", "datajudultimomovimento", "ultimamovimentacao", "dataultimamovimento"]);
      if (dm) {
        var dmi = parseDate(dm);
        if (dmi) outC.datajud_ultimo_movimento = dmi;
      }
      var sim = function (v) { return /^(sim|s|yes|true|1)$/i.test(String(v || "").trim()); };
      var evento = pk(["eventotipo", "tipoevento", "tipodeevento"]);
      if (evento) outC.evento_resumo = evento;
      if (sim(pk(["novoandamento"]))) outC.tem_novo_andamento = true;
      if (sim(pk(["encerradotribunal"]))) outC.datajud_encerrado_tribunal = true;
      if (sim(pk(["buscaapreensao", "buscaeapreensao"]))) outC.em_busca_apreensao = true;
      if (sim(pk(["cumprimento", "cumprimentosentenca", "emcumprimento"]))) outC.em_cumprimento_sentenca = true;
      if (sim(pk(["procedente"]))) outC.is_procedente = true;
      if (sim(pk(["improcedente"]))) outC.is_improcedente = true;
      if (outC.em_cumprimento_sentenca && !outC.evento_resumo) outC.evento_resumo = "cumprimento de sentença";
      out.push(outC);
    }
    if (out.length) {
      colMap = {};
      var FL = {
        protocolo: /protocolo|cnj|processo|numero|protocoloref/,
        cliente: /cliente|nome|parte|autor|consumidor/,
        telefone: /telefone|celular|whatsapp|fone|tel|movel/,
        tribunal: /tribunal|vara|comarca|foro/,
        advogado: /advogado|responsavel/,
        escritorio: /escritorio|unidade/,
        situacao: /situacao|status|andamento|conclusos|fase/,
        ultimoRetorno: /^(retorno|ultimo|ultimoretorno|retornoanterior|retornofeito)$/,
        proximoPrazo: /^(proximoretorno|proxretorno|prazo|proximoprazo|dataproximoretorno|retornocliente|proximocontato)$/,
        observacao: /obs|observacao|notas/,
        assistente: /assistente|atendente|operador/,
        evento_resumo: /eventotipo|tipoevento|tipodeevento/,
        tem_novo_andamento: /novoandamento/,
        datajud_encerrado_tribunal: /encerradotribunal/,
        em_busca_apreensao: /buscaapreensao|buscaeapreensao/,
        em_cumprimento_sentenca: /cumprimento|emcumprimento/,
        is_procedente: /^procedente$/,
        is_improcedente: /^improcedente$/,
        datajud_ultimo_movimento: /datamovimentacao|datajudultimomovimento|ultimamovimentacao/
      };
      for (var f in FL) {
        for (var x = 0; x < nh.length; x++) {
          if (FL[f].test(nh[x])) { colMap[f] = headers[x]; break; }
        }
      }
    }
    lastDiag = { headers: headers, headerLine: hi + 1, retorno: iR === -1 ? null : colName(iR), proximo: iP === -1 ? null : colName(iP), linhas: out.length };
    try { console.log("[Lexis CSV]", lastDiag, colMap); } catch (e) {}
    return out;
  }
  function csvDiagText() {
    var d = lastDiag;
    if (!d) return "nada importado";
    return "Coluna RETORNO = " + (d.retorno || "-") + " · Coluna PRÓXIMO = " + (d.proximo || "-") + " · " + d.linhas + " linhas";
  }

  /* ============================ persistência local ============================ */
  function scheduleSave() {
    if (!window.lexisOffline || !window.lexisOffline.saveDb) return;
    clearTimeout(window.__saveT);
    window.__saveT = setTimeout(function () {
      saveNow();
    }, 350);
  }
  function saveNow() {
    if (!window.lexisOffline || !window.lexisOffline.saveDb) return;
    window.lexisOffline.saveDb({ rows: rows, notes: notes, outbox: outbox, colMap: colMap, savedAt: new Date().toISOString() })
      .then(function () {}).catch(function () {});
  }
  function loadFromDisk() {
    if (!window.lexisOffline || !window.lexisOffline.loadDb) return Promise.resolve();
    return window.lexisOffline.loadDb().then(function (data) {
      if (data) {
        if (Array.isArray(data.rows)) rows = data.rows;
        if (Array.isArray(data.notes)) notes = data.notes;
        if (Array.isArray(data.outbox)) outbox = data.outbox;
        if (data.colMap && typeof data.colMap === "object") colMap = data.colMap;
        if (data.savedAt) lastSync = data.savedAt;
        renderAll();
        toast("Carteira: " + rows.length + " processos");
      }
    }).catch(function () {});
  }

  /* ============================ sync 2 vias ============================ */
  function loadCfg() {
    try {
      cfg.url = localStorage.getItem(LS.url) || "";
      cfg.webhook = localStorage.getItem(LS.web) || "";
      cfg.token = localStorage.getItem(LS.tok) || "w1-fase1-2026";
      cfg.oper = localStorage.getItem(LS.oper) || "";
    } catch (e) {}
  }
  function readCfgFromInputs(allowEmptyWipe) {
    // allowEmptyWipe=true só no botão Salvar explícito
    try {
      var u = $("cfgUrl") ? $("cfgUrl").value.trim() : "";
      var w = $("cfgWebhook") ? $("cfgWebhook").value.trim() : "";
      var tok = $("cfgToken") ? $("cfgToken").value.trim() : "";
      var op = $("cfgOper") ? $("cfgOper").value.trim() : "";
      if (w) w = w.replace(/\/dev(\b|$)/, "/exec");
      if (allowEmptyWipe) {
        cfg.url = u;
        cfg.webhook = w;
        cfg.token = tok || cfg.token || "w1-fase1-2026";
        cfg.oper = op;
      } else {
        if (u) cfg.url = u;
        if (w) cfg.webhook = w;
        if (tok) cfg.token = tok;
        if (op) cfg.oper = op;
      }
    } catch (e) {}
  }
  function saveCfg() {
    try {
      localStorage.setItem(LS.url, cfg.url || "");
      localStorage.setItem(LS.web, cfg.webhook || "");
      localStorage.setItem(LS.tok, cfg.token || "");
      localStorage.setItem(LS.oper, cfg.oper || "");
    } catch (e) {}
  }
  function sheetRow(c) {
    var p = { Protocolo: c.protocolo };
    function set(field, defKey, val) {
      if (val === undefined || val === null || val === "") return;
      var real = colMap[field];
      p[real || defKey] = val;
    }
    set("cliente", "Cliente", c.cliente);
    set("telefone", "Telefone", c.telefone);
    set("tribunal", "Tribunal", c.tribunal);
    set("advogado", "Advogado", c.advogado);
    set("escritorio", "Escritorio", c.escritorio);
    set("situacao", "Situacao", c.situacao);
    set("ultimoRetorno", "Retorno", c.ultimoRetorno);
    set("proximoPrazo", "Proximo_Retorno", c.proximoPrazo);
    set("observacao", "Observacoes", c.observacao);
    return p;
  }
  function postRows(body) {
    if (!window.lexisOffline || !window.lexisOffline.fetchJson) return Promise.reject(new Error("sem IPC"));
    if (!cfg.webhook) return Promise.reject(new Error("webhook não configurado"));
    var wh = String(cfg.webhook).trim().replace(/\/dev(\b|$)/, "/exec");
    return window.lexisOffline.fetchJson(wh, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }
  function pushOne(c) {
    if (!cfg.webhook) {
      queueOutbox(c);
      return false;
    }
    var row = sheetRow(c);
    postRows({ token: cfg.token, rows: [row] }).then(function (r) {
      if (r && r.ok && r.json && r.json.ok) {
        toast("Enviado para a planilha (" + (r.json.updated || 0) + ")");
        popOutbox(c.id || c.protocolo);
      } else {
        toast("Falha no webhook — guardado para sincronizar", "err-msg");
        queueOutbox(c);
      }
    }).catch(function () {
      toast("Offline — alteração guardada para sincronizar", "err-msg");
      queueOutbox(c);
    });
    return true;
  }
  function queueOutbox(c) {
    var key = onlyDigits(c.protocolo) || c.id;
    outbox = outbox.filter(function (o) { return o.key !== key; });
    outbox.push({ key: key, row: sheetRow(c), ts: new Date().toISOString() });
    setSyncPill("pendências: " + outbox.length, "warn");
    scheduleSave();
  }
  function popOutbox(id) {
    var key = onlyDigits(id) || id;
    outbox = outbox.filter(function (o) { return o.key !== key; });
    scheduleSave();
  }
  function doPull() {
    if (!cfg.url) return Promise.resolve(null);
    if (!window.lexisOffline || !window.lexisOffline.fetchText) return Promise.reject(new Error("Abra pelo EXE"));
    return window.lexisOffline.fetchText(cfg.url).then(function (res) {
      if (!res || !res.ok) throw new Error((res && res.error) || "falha na planilha");
      var incoming = parseCsv(res.text || "");
      if (!incoming.length) throw new Error("nenhuma linha válida: " + csvDiagText());
      rows = incoming;
      // reaplica pendências locais por cima
      outbox.forEach(function (o) {
        for (var i = 0; i < rows.length; i++) {
          if (onlyDigits(rows[i].protocolo) === o.key) {
            for (var f in o.row) {
              var v = o.row[f];
              if (f === "Protocolo") continue;
              var low = normHeader(f);
              if (low === normHeader(colMap.ultimoRetorno) || low === "retorno" || low === "ultimoretorno") rows[i].ultimoRetorno = parseDate(v) || rows[i].ultimoRetorno;
              else if (low === normHeader(colMap.proximoPrazo) || low === "proximoretorno" || low === "proximoprazo" || low === "prazo") rows[i].proximoPrazo = parseDate(v) || rows[i].proximoPrazo;
              else if (low === normHeader(colMap.observacao) || /obs/.test(low)) rows[i].observacao = v;
              else if (low === normHeader(colMap.situacao) || /situac|status/.test(low)) rows[i].situacao = v;
            }
          }
        }
      });
      scheduleSave();
      renderAll();
      setSyncPill("sync " + new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }), "ok");
      return incoming;
    });
  }
  function doPush() {
    if (!cfg.webhook) return Promise.resolve({ skipped: true });
    if (!outbox.length) return Promise.resolve({ skipped: true });
    var rowsPayload = outbox.map(function (o) { return o.row; });
    return postRows({ token: cfg.token, rows: rowsPayload }).then(function (r) {
      if (r && r.ok && r.json && r.json.ok) {
        outbox = [];
        setSyncPill("sync " + new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }), "ok");
        toast("Pendências enviadas: " + (r.json.updated || rowsPayload.length));
      } else {
        var rec = (r && r.json && r.json.error) || (r && r.error) || (r && r.text ? String(r.text).slice(0, 120) : "erro");
        toast("Webhook recusou: " + rec, "err-msg");
      }
      scheduleSave();
      renderAll();
      return r;
    });
  }
  function syncAll() {
    readCfgFromInputs(false);
    saveCfg();
    var t0 = Date.now();
    setSyncPill("sincronizando…", "warn");
    var watchdog = setTimeout(function () {
      setSyncPill("erro: travou (" + Math.round((Date.now() - t0) / 1000) + "s)", "err");
      toast("Sync travou em " + Math.round((Date.now() - t0) / 1000) + "s — rede ou Google lento", "err-msg");
    }, 75000);
    function done() { clearTimeout(watchdog); }
    Promise.resolve()
      .then(doPull)
      .then(doPush)
      .catch(function (e) {
        setSyncPill("erro: " + (e && e.message ? e.message.slice(0, 40) : "falha"), "err");
        toast("Sync: " + (e && e.message ? e.message : "falhou"), "err-msg");
      })
      .then(done);
  }
  function setSyncPill(txt, cls) {
    var p = $("syncPill");
    p.textContent = txt;
    p.className = "pill" + (cls ? " " + cls : "");
  }
  function testWebhook() {
    if (!$("cfgStatus")) return;
    var st = $("cfgStatus");
    try {
      if ($("cfgWebhook")) cfg.webhook = $("cfgWebhook").value.trim();
      if ($("cfgToken")) cfg.token = $("cfgToken").value.trim();
    } catch (e1) {}
    if (!cfg.token) cfg.token = "w1-fase1-2026";
    st.className = "hint";
    st.textContent = "Testando…";
    var wh = String(cfg.webhook || "").trim().replace(/\/dev(\b|$)/, "/exec");
    if (!wh) {
      st.className = "hint err-msg";
      st.textContent = "Cole a URL /exec do Apps Script.";
      return;
    }
    if (/docs\.google\.com/i.test(wh)) {
      st.className = "hint err-msg";
      st.textContent = "Isso é a planilha. Webhook = script.google.com/.../exec";
      return;
    }
    cfg.webhook = wh.replace(/\/exec\/?\s*$/, "/exec");
    try {
      localStorage.setItem("lexis_g_webhook", cfg.webhook);
      localStorage.setItem("lexis_g_token", cfg.token);
    } catch (e2) {}
    if (!window.lexisOffline || !window.lexisOffline.fetchJson) {
      st.className = "hint err-msg";
      st.textContent = "Sem IPC — reabra o EXE.";
      return;
    }
    var getUrl = cfg.webhook + "?action=ping&token=" + encodeURIComponent(cfg.token);
    window.lexisOffline.fetchJson(getUrl, { method: "GET" }).then(function (r) {
      if (r && r.json && r.json.pong === true) {
        st.className = "hint ok-msg";
        st.textContent = "Webhook OK ✓";
        if (typeof toast === "function") toast("Webhook conectado", "ok-msg");
        return;
      }
      // POST (doPost ping) — redirect correto = GET no usercontent
      return window.lexisOffline.fetchJson(cfg.webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: cfg.token, action: "ping", ping: true })
      }).then(function (r2) {
        if (r2 && r2.json && r2.json.pong === true) {
          st.className = "hint ok-msg";
          st.textContent = "Webhook OK ✓ (POST)";
          if (typeof toast === "function") toast("Webhook conectado", "ok-msg");
          return;
        }
        if (r2 && r2.json && r2.json.ok && r2.json.app && !r2.json.pong) {
          st.className = "hint err-msg";
          st.textContent = "Script no ar, mas SEM pong. Apps Script: cole o .gs novo → Implantar → Nova versão.";
          return;
        }
        if (r && r.json && r.json.ok && r.json.app && !r.json.pong) {
          st.className = "hint err-msg";
          st.textContent = "Script antigo no /exec. Implantar → Nova versão com doGet que devolve pong.";
          return;
        }
        var err = (r2 && (r2.error || (r2.json && r2.json.error))) || (r && r.error) || "";
        var raw = String((r2 && r2.raw) || (r && r.raw) || "").replace(/\s+/g, " ").slice(0, 80);
        st.className = "hint err-msg";
        st.textContent = err || ("HTTP " + ((r2 && r2.http) || (r && r.http)) + " — " + raw);
      });
    }).catch(function (e) {
      st.className = "hint err-msg";
      st.textContent = "Rede: " + (e && e.message ? e.message : e);
    });
  }

  function kpiCard(l, v, cls, s) {
    return '<div class="kpi ' + (cls || "") + '"><div class="l">' + l + '</div><div class="v">' + v + '</div>' + (s ? '<div class="s">' + s + "</div>" : "") + "</div>";
  }
  function actionsHtml(c) {
    return '<div class="row-actions">' +
      '<button type="button" class="btn btn-sm" data-act="atend" data-id="' + esc(c.id) + '">Atender</button>' +
      '<button type="button" class="btn btn-sm" data-act="edit" data-id="' + esc(c.id) + '">Editar</button>' +
      '<button type="button" class="btn btn-sm" data-act="scan" data-id="' + esc(c.id) + '" title="Consultar DataJud+DJEN">Scan</button>' +
      (c.telefone ? '<button type="button" class="btn btn-sm" data-act="wa" data-id="' + esc(c.id) + '">WhatsApp</button>' : "") +
      (c.protocolo ? '<button type="button" class="btn btn-sm" data-act="abrir" data-id="' + esc(c.id) + '" title="Abrir consulta no tribunal">CNJ</button>' : "") +
      "</div>";
  }
  function rowHtml(c, extraCols) {
    var st = statusDe(c);
    var f = faixaPrioridade(pesoFila(c));
    var dias = diasAte(c.proximoPrazo);
    var h = "<tr" + (st === "Vencido" || st === "Caso Crítico" ? ' style="background:rgba(239,68,68,.05)"' : "") + "><td><b>" + esc(c.cliente || "—") + '</b><div class="mini">' + esc(c.protocolo || "") + "</div></td>";
    h += "<td>" + badge(st) + '</td><td><span class="num">' + esc(c.proximoPrazo || "—") + "</span></td>";
    h += "<td>" + (dias === null ? "—" : '<span class="num" style="color:' + (dias < 0 ? "var(--vencido)" : dias === 0 ? "var(--hoje)" : "var(--muted)") + '">' + dias + "</span>") + "</td>";
    h += '<td><span class="badge ' + f[1] + '">' + f[0] + "</span></td>";
    if (typeof extraCols === "function") h += extraCols(c);
    else if (extraCols) h += extraCols;
    h += "<td>" + actionsHtml(c) + "</td></tr>";
    return h;
  }
  function tableHtml(list, cols, extra, extraHeader) {
    if (!list.length) return '<div class="empty"><b>Nada aqui</b>Importe a planilha em Importar ou ajuste o filtro.</div>';
    var h = "<table><thead><tr>";
    (cols || ["Cliente", "Status", "Retorno", "Dias", "Prioridade"]).forEach(function (c) { h += "<th>" + c + "</th>"; });
    if (typeof extra === "function") h += "<th>" + (extraHeader || "") + "</th>";
    else if (extra) h += "<th>" + extra + "</th>";
    h += "<th>Ações</th></tr></thead><tbody>";
    list.forEach(function (r) { h += rowHtml(r, extra); });
    h += "</tbody></table>";
    return h;
  }

  function renderDashboard() {
    var k = kpisAll();
    var risk = computeRisk(k);
    $("capPill").textContent = k.total + " proc.";
    $("kpiRow").innerHTML =
      kpiCard("Carteira", k.total, "", k.ativos + " ativos") +
      kpiCard("Vencidos", k.venc, k.venc ? "err" : "") +
      kpiCard("É hoje", k.hoje, k.hoje ? "hoje" : "") +
      kpiCard("Atenção", k.aten, k.aten ? "warn" : "") +
      kpiCard("Sem prazo", k.sem, "pri") +
      kpiCard("Arquivados", k.arq, "", "encerrados/casos") +
      kpiCard("Atendidos hoje", k.atendidosHoje, k.atendidosHoje ? "ok" : "") +
      kpiCard("Novidades", k.nov, k.nov ? "rose" : "");

    var crit = sortByPriority(rows.filter(function (c) {
      var st = statusDe(c); return st === "Vencido" || st === "É Hoje" || st === "Caso Crítico";
    })).slice(0, 40);
    $("critTable").innerHTML = crit.length
      ? tableHtml(crit, ["Cliente", "Status", "Retorno", "Dias", "Prioridade"])
      : '<div class="empty"><b>Fila limpa</b>Nenhum vencido ou retorno para hoje.</div>';

    var rn = $("riskNum");
    rn.textContent = risk.score;
    rn.style.background = "conic-gradient(" + risk.color + " " + (risk.score * 3.6) + "deg, var(--elev) 0deg)";
    rn.innerHTML = risk.score + '<span class="lbl">' + risk.label + "</span>";
    var rb = $("riskBarWrap");
    rb.innerHTML = '<div class="bar"><div style="width:' + Math.max(4, risk.score) + '%;background:' + risk.color + '"></div></div>';
    rb.insertAdjacentHTML("afterbegin", '<div class="mini" style="margin-bottom:.3rem">Índice de risco · ' + risk.label + "</div>");
    $("riskLegend").innerHTML = risk.fatores.map(function (f) {
      return '<div><span class="dot" style="background:' + f[1] + '"></span>' + esc(f[0]) + "</div>";
    }).join("") || '<div class="mini">Carteira saudável.</div>';

    var segs = [];
    segs.push(["Vencido", k.venc, "#ef4444"]);
    segs.push(["É hoje", k.hoje, "#3b82f6"]);
    segs.push(["Atenção", k.aten, "#f97316"]);
    segs.push(["No prazo", k.seguro, "#10b981"]);
    segs.push(["Sem prazo", k.sem, "#94a3b8"]);
    var total = k.ativos || 1;
    var bar = '<div class="bar" style="display:flex;gap:2px;height:14px">';
    segs.forEach(function (s) {
      if (!s[1]) return;
      bar += '<div style="width:' + Math.round((s[1] / total) * 100) + '%;background:' + s[2] + '"></div>';
    });
    bar += "</div>";
    $("saudeBar").innerHTML = bar;
    $("saudeLeg").innerHTML = segs.map(function (s) {
      return '<div><span class="dot" style="background:' + s[2] + '"></span><span>' + s[0] + " · </span><b>" + s[1] + "</b></div>";
    }).join("");

    var hoje = hojeBR();
    var week = rows.filter(function (c) {
      var st = statusDe(c); if (st === "Arquivado") return false;
      var d = diasAte(c.proximoPrazo); return d !== null && d >= 0 && d <= 7;
    });
    $("agendaMini").innerHTML = week.length
      ? tableHtml(sortByPriority(week), ["Cliente", "Status", "Retorno", "Dias", "Prioridade"])
      : '<div class="empty"><b>Nada nos próximos 7 dias</b></div>';

    var novas = rows.filter(function (c) {
      return (c.tem_novo_andamento || c.djen_nova_comunicacao) && statusDe(c) !== "Arquivado";
    }).slice(0, 30);
    $("novaTable").innerHTML = novas.length
      ? tableHtml(novas, ["Cliente", "Status", "Retorno", "Dias", "Prioridade"])
      : '<div class="empty">Nenhuma novidade detectada ainda (use o Scanner).</div>';

    var d = lastDiag;
    if (d) {
      var stEl = $("sheetsStatus");
      if (stEl) { stEl.textContent = csvDiagText(); stEl.className = "pill ok"; }
    }
  }
  function renderFila() {
    var k = kpisAll();
    $("filaKpis").innerHTML =
      kpiCard("Vencidos", k.venc, k.venc ? "err" : "") +
      kpiCard("É hoje", k.hoje, k.hoje ? "hoje" : "") +
      kpiCard("Atenção", k.aten, k.aten ? "warn" : "") +
      kpiCard("Sem prazo", k.sem, "pri");
    var ft = ($("filtroFila") && $("filtroFila").value) || "fila";
    var q = (($("qFila") && $("qFila").value) || "").toLowerCase();
    var list = rows.filter(function (c) {
      var st = statusDe(c);
      if (st === "Arquivado") return false;
      if (ft === "fila" && st !== "Vencido" && st !== "É Hoje" && st !== "Caso Crítico") return false;
      if (ft === "vencido" && st !== "Vencido" && st !== "Caso Crítico") return false;
      if (ft === "hoje" && st !== "É Hoje") return false;
      if (ft === "atencao" && st !== "Atenção") return false;
      if (q && String(c.cliente + " " + c.protocolo + " " + c.telefone).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var ordered = sortByPriority(list);
    var fh = "";
    ordered.slice(0, 300).forEach(function (c) {
      var st = statusDe(c);
      var dias = diasAte(c.proximoPrazo);
      var f = faixaPrioridade(pesoFila(c));
      var bc = (st === "Vencido" || st === "Caso Cr\u00edtico") ? "var(--vencido)" : st === "\u00c9 Hoje" ? "var(--hoje)" : st === "Aten\u00e7\u00e3o" ? "var(--atencao)" : "var(--border)";
      var dc = dias !== null && dias < 0 ? "var(--vencido)" : dias === 0 ? "var(--hoje)" : "var(--muted)";
      var dt = dias === null ? "\u2014" : (dias < 0 ? Math.abs(dias) + "d vencido" : dias + "d");
      fh += '<div style="background:var(--card);border:1px solid var(--border);border-left:4px solid ' + bc + ';border-radius:.75rem;padding:.7rem .85rem;margin-bottom:.5rem;transition:all .15s">';
      fh += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem">';
      fh += '<div style="min-width:0;flex:1"><div style="font-weight:800;font-size:.78rem;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(c.cliente || "\u2014") + '</div>';
      fh += '<div style="font-size:6px;color:var(--muted);font-family:monospace;margin-top:2px">' + esc(c.protocolo || "") + '</div></div>';
      fh += '<div style="display:flex;gap:.3rem;flex-shrink:0">' + badge(st) + '<span class="badge ' + f[1] + '">' + f[0] + '</span></div></div>';
      fh += '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:.5rem;flex-wrap:wrap;gap:.4rem">';
      fh += '<div style="font-size:.68rem;color:var(--muted)">Retorno: <b style="color:var(--text)">' + esc(c.proximoPrazo || "\u2014") + '</b></div>';
      fh += '<div style="font-weight:800;font-size:.72rem;color:' + dc + '">' + dt + '</div></div>';
      fh += '<div class="row-actions" style="margin-top:.5rem">';
      fh += '<button type="button" class="btn btn-sm" data-act="atend" data-id="' + esc(c.id) + '">Atender</button>';
      fh += '<button type="button" class="btn btn-sm" data-act="edit" data-id="' + esc(c.id) + '">Editar</button>';
      fh += '<button type="button" class="btn btn-sm" data-act="scan" data-id="' + esc(c.id) + '">Scan</button>';
      if (c.telefone) fh += '<button type="button" class="btn btn-sm" data-act="wa" data-id="' + esc(c.id) + '">WhatsApp</button>';
      fh += '</div></div>';
    });
    if (!ordered.length) fh = '<div class="empty"><b>Fila limpa</b>Nenhum vencido ou retorno para hoje.</div>';
    $("filaTable").innerHTML = fh;
  }
  function renderCasos() {
    var q = (($("qCasos") && $("qCasos").value) || "").toLowerCase();
    var ft = ($("filtroCasos") && $("filtroCasos").value) || "ativos";
    var list = rows.filter(function (c) {
      var st = statusDe(c);
      if (ft === "ativos" && st === "Arquivado") return false;
      if (ft === "arq" && st !== "Arquivado") return false;
      if (ft === "vencido" && st !== "Vencido" && st !== "Caso Crítico") return false;
      if (ft === "hoje" && st !== "É Hoje") return false;
      if (ft === "sem" && st !== "Sem Prazo") return false;
      if (q && String(c.cliente + " " + c.protocolo + " " + c.telefone).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    $("casosTable").innerHTML = tableHtml(sortByPriority(list).slice(0, 400), ["Cliente", "Status", "Retorno", "Dias", "Prioridade"]);
  }
  function renderProcessos() {
    var k = kpisAll();
    var atendSemana = [];
    rows.forEach(function (c) {
      if (!c.ultimoRetorno || statusDe(c) === "Arquivado") return;
      var d = diasDesde(c.ultimoRetorno);
      if (d !== null && d >= 0 && d <= 7) atendSemana.push(c);
    });
    var rank = {};
    atendSemana.forEach(function (c) {
      var who = (c.atendido_por || "não informado");
      rank[who] = (rank[who] || 0) + 1;
    });
    var rankList = Object.keys(rank).sort(function (a, b) { return rank[b] - rank[a]; }).slice(0, 5);
    $("empKpis").innerHTML =
      kpiCard("Total", k.total, "") +
      kpiCard("Ativos", k.ativos, "pri") +
      kpiCard("Encerrados", k.arq, "") +
      kpiCard("Vencidos", k.venc, k.venc ? "err" : "") +
      kpiCard("Baixas tribunal", k.baixa, k.baixa ? "hoje" : "") +
      kpiCard("Atendidos semana", atendSemana.length, atendSemana.length ? "ok" : "");
    $("rankBox").innerHTML = rankList.length
      ? rankList.map(function (w, i) {
          return '<div style="display:flex;align-items:center;gap:.5rem;padding:.3rem 0;border-bottom:1px solid var(--border2)"><b style="width:22px;color:var(--muted)">' + (i + 1) + ".</b><span style='flex:1;font-weight:700'>" + esc(w) + '</span><span class="badge b-pri">' + rank[w] + "</span></div>";
        }).join("")
      : '<div class="empty">Sem atendimentos na semana ainda.</div>';
    $("empTable").innerHTML = tableHtml(sortByPriority(rows).slice(0, 500), ["Cliente", "Status", "Retorno", "Dias", "Prioridade"]);
  }
  function renderParados() {
    var hoje = hojeBR();
    var parados = rows.filter(function (c) {
      var st = statusDe(c); if (st === "Arquivado") return false;
      var base = c.ultimoRetorno || c.data_distribuicao;
      var d = diasDesde(base);
      return !c.datajud_ultimo_movimento && (d === null ? true : d >= 60);
    });
    var crit = parados.filter(function (c) {
      var d = diasDesde(c.ultimoRetorno || c.data_distribuicao);
      return d === null || d >= 90;
    });
    $("parKpis").innerHTML =
      kpiCard("Parados 60+", parados.length, parados.length ? "warn" : "ok") +
      kpiCard("Parados 90+", crit.length, crit.length ? "err" : "ok") +
      kpiCard("Ativos (controle)", kpisAll().ativos, "pri");
    function extra(c) {
      var base = c.ultimoRetorno || c.data_distribuicao;
      var d = diasDesde(base);
      return '<td><span class="badge ' + (d === null || d >= 90 ? "b-ven" : "b-aten") + '">' + (d === null ? "sem registro" : d + " dias") + "</span></td>";
    }
    $("paradosTable").innerHTML = tableHtml(sortByPriority(parados).slice(0, 200), ["Cliente", "Status", "Retorno", "Dias", "Prioridade", "Parado há"], extra);
  }
  function renderEncerrados() {
    var list = rows.filter(function (c) { return statusDe(c) === "Arquivado"; });
    var hoje = hojeBR();
    var hojeCount = list.filter(function (c) { return c.auditado_em === hoje; }).length;
    $("encKpis").innerHTML =
      kpiCard("Encerrados", list.length, "pri") +
      kpiCard("Encerrados hoje", hojeCount, hojeCount ? "ok" : "");
    function extra(c) {
      return '<td><button type="button" class="btn btn-sm" data-act="desfazer" data-id="' + esc(c.id) + '">Desfazer</button></td>';
    }
    $("encerTable").innerHTML = tableHtml(list.slice(0, 200), ["Cliente", "Status", "Retorno", "Dias", "Prioridade", "Revisão"], extra);
  }
  function renderAgenda() {
    var k = kpisAll();
    var week = rows.filter(function (c) {
      var st = statusDe(c); if (st === "Arquivado") return false;
      var d = diasAte(c.proximoPrazo); return d !== null && d >= 0 && d <= 7;
    });
    var venc = rows.filter(function (c) {
      var st = statusDe(c); return st === "Vencido" || st === "Caso Crítico";
    });
    $("agKpis").innerHTML =
      kpiCard("Nesta semana", week.length, week.length ? "pri" : "") +
      kpiCard("Vencidos", k.venc, k.venc ? "err" : "") +
      kpiCard("É hoje", k.hoje, k.hoje ? "hoje" : "");
    $("agendaTable").innerHTML = tableHtml(sortByPriority(week), ["Cliente", "Status", "Retorno", "Dias", "Prioridade"]);
  }
  function renderNotas() {
    if (!notes.length) {
      $("notasList").innerHTML = '<div class="empty"><b>Nenhuma nota</b>Anotações locais (não vão para a planilha).</div>';
      return;
    }
    $("notasList").innerHTML = notes.slice().reverse().slice(0, 60).map(function (n) {
      return '<div style="border-bottom:1px solid var(--border2);padding:.45rem 0"><b>' + esc(n.ref) + '</b> <span class="mini">· ' + esc(n.at) + "</span><div>" + esc(n.text) + "</div></div>";
    }).join("");
  }
  function renderConfig() {
    $("cfgUrl").value = cfg.url || "";
    $("cfgWebhook").value = cfg.webhook || "";
    $("cfgToken").value = cfg.token || "";
    $("cfgOper").value = cfg.oper || "";
  }
  function renderAll() {
    renderDashboard();
    renderFila();
    renderCasos();
    renderProcessos();
    renderParados();
    renderEncerrados();
    renderAgenda();
    renderNotas();
  }

  /* ============================ navegação ============================ */
  var current = "dashboard";
  function nav(name) {
    current = name;
    document.querySelectorAll(".nav").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-nav") === name);
    });
    document.querySelectorAll(".panel").forEach(function (p) {
      p.classList.toggle("active", p.id === "p-" + name);
    });
    $("pageTitle").textContent = TITLES[name][0];
    $("pageSub").textContent = TITLES[name][1];
    if (name === "scanner") {
      renderScanUI();
      scanTab($("sctab-logs") && $("sctab-logs").style.display === "block" ? "logs" : "varredura");
    }
  }

  /* ============================ atendimento / edição ============================ */
  function findById(id) {
    return rows.find(function (c) { return c.id === id; });
  }
  function openAtend(id) {
    var c = findById(id); if (!c) return;
    editId = id;
    $("modalCliente").textContent = (c.cliente || "—") + " · " + (c.protocolo || "");
    $("atendPrazo").value = c.proximoPrazo || "";
    $("atendUltimo").value = c.ultimoRetorno || hojeBR();
    $("atendObs").value = "";
    $("atendEncerrar").checked = false;
    $("modalAtend").classList.add("show");
    setTimeout(function () { if ($("atendPrazo")) $("atendPrazo").focus(); }, 60);
  }
  function saveAtendimento() {
    var c = findById(editId); if (!c) return;
    var prazo = $("atendPrazo").value || "";
    var ultimo = $("atendUltimo").value || hojeBR();
    var obs = ($("atendObs").value || "").trim();
    var encerrar = $("atendEncerrar").checked;
    c.ultimoRetorno = ultimo;
    c.proximoPrazo = prazo || null;
    if (obs) c.observacao = c.observacao ? (c.observacao + "\n" + obs) : obs;
    c.atendido_por = cfg.oper || "";
    c.auditado_em = hojeBR();
    c.auditado_por = cfg.oper || "";
    if (encerrar) {
      c.situacao = "ENCERRADO";
      c.statusManual = "Encerrado";
    } else {
      c.situacao = (!c.situacao || /^ENCERRAD/ .test(c.situacao) || /ENCERRAD/.test(c.situacao)) && c.situacao ? c.situacao.replace(/ENCERRADO.*/i, "").trim() || "EM ANDAMENTO" : (c.situacao || "EM ANDAMENTO");
      c.statusManual = "Automatico";
    }
    $("modalAtend").classList.remove("show");
    scheduleSave();
    renderAll();
    toast("Atendimento salvo" + (encerrar ? " · encerrado" : "") + (cfg.webhook ? " · enviando p/ planilha" : " · local (sem webhook)"));
    pushOne(c);
  }
  function openEdit(id) {
    var c = findById(id); if (!c) return;
    editId = id;
    $("editTitle").textContent = "Editar · " + (c.cliente || "—");
    $("edCliente").value = c.cliente || "";
    $("edProtocolo").value = c.protocolo || "";
    $("edTelefone").value = c.telefone || "";
    $("edTribunal").value = c.tribunal || "";
    $("edAdvogado").value = c.advogado || "";
    $("edEscritorio").value = c.escritorio || "";
    $("edSituacao").value = c.situacao || "";
    $("edStatusManual").value = c.statusManual === "Automatico" ? "Automatico" : c.statusManual || "Automatico";
    $("edUltimo").value = c.ultimoRetorno || "";
    $("edPrazo").value = c.proximoPrazo || "";
    $("edObs").value = c.observacao || "";
    $("modalEdit").classList.add("show");
  }
  function saveEdit() {
    var c = findById(editId); if (!c) return;
    c.cliente = $("edCliente").value.trim() || c.cliente;
    var novoProt = $("edProtocolo").value.trim();
    if (novoProt) { c.protocolo = novoProt; c.id = onlyDigits(novoProt) || c.id; }
    c.telefone = $("edTelefone").value.trim();
    c.tribunal = $("edTribunal").value.trim();
    c.advogado = $("edAdvogado").value.trim();
    c.escritorio = $("edEscritorio").value.trim();
    c.situacao = $("edSituacao").value.trim() || c.situacao;
    c.statusManual = $("edStatusManual").value;
    c.ultimoRetorno = $("edUltimo").value || null;
    c.proximoPrazo = $("edPrazo").value || null;
    c.observacao = $("edObs").value;
    c.auditado_em = hojeBR();
    c.auditado_por = cfg.oper || "";
    c.edited_by_name = cfg.oper || "";
    $("modalEdit").classList.remove("show");
    scheduleSave();
    renderAll();
    toast("Processo salvo" + (cfg.webhook ? " · enviando p/ planilha" : ""));
    pushOne(c);
  }
  function deleteEdit() {
    var c = findById(editId); if (!c) return;
    if (!confirm("Excluir '" + (c.cliente || "—") + "' da carteira local?")) return;
    rows = rows.filter(function (x) { return x.id !== c.id; });
    $("modalEdit").classList.remove("show");
    scheduleSave();
    renderAll();
    toast("Removido localmente. Para apagar na planilha, exclua a linha lá.");
  }

  /* ============================ scanner / veredito (LexisEspecial) ============================ */
  function normalizeCnjInput(s) {
    var d = onlyDigits(s);
    return d.length === 20 ? formatCnj(d) : String(s || "").trim();
  }
  function runScanMode(cnjRaw, mode) {
    var cnj = normalizeCnjInput(cnjRaw);
    var d = onlyDigits(cnj);
    if (d.length !== 20) {
      return Promise.resolve({ error: "CNJ precisa de 20 dígitos (você colou " + d.length + ")." });
    }
    if (!window.lexisOffline) return Promise.resolve({ error: "Abra pelo EXE" });
    var p = [];
    if (mode === "both" || mode === "datajud") p.push(window.lexisOffline.datajud(cnj));
    else p.push(Promise.resolve(null));
    if (mode === "both" || mode === "djen") p.push(window.lexisOffline.djen(cnj));
    else p.push(Promise.resolve(null));
    return Promise.all(p).then(function (r) {
      return { cnj: formatCnj(d), datajud: r[0], djen: r[1] };
    });
  }
  function runScan(cnjRaw) { return runScanMode(cnjRaw, "both"); }
  function applyScanToCase(c, res) {
    var ch = { alert: false, djen: false, closed: false };
    var dj = res && res.datajud, dn = res && res.djen;
    if (dj && dj.ok) {
      if (dj.ultimoNome) {
        var prev = c.datajud_ultimo_movimento;
        c.datajud_ultimo_nome = dj.ultimoNome;
        c.datajud_ultimo_movimento = dj.ultimoData || c.datajud_ultimo_movimento;
        c.evento_resumo = dj.ultimoNome;
        c.evento_data = dj.ultimoData || null;
        if (prev !== c.datajud_ultimo_movimento || !c.tem_novo_andamento) { c.tem_novo_andamento = true; ch.alert = true; }
      }
      if (dj.source) {
        var sit = (dj.source.situacao || dj.source.classe || "").toString().toUpperCase();
        if (/ENCERRAD|ARQUIVAD|BAIXA|EXTINT/.test(sit) && !c.datajud_encerrado_tribunal) ch.closed = true;
        if (/ENCERRAD|ARQUIVAD|BAIXA|EXTINT/.test(sit)) c.datajud_encerrado_tribunal = true;
        var movs = dj.movimentos || [];
        var txt = movs.map(function (m) { return (m.nome || m.descricao || "").toString().toLowerCase(); }).join(" ");
        if (/improcedente/.test(txt)) c.is_improcedente = true;
        if (/procedente/.test(txt)) c.is_procedente = true;
        if (/cumprimento/.test(txt)) c.em_cumprimento_sentenca = true;
      }
      c.datajud_consultado_em = hojeBR();
    }
    if (dn && dn.ok) {
      if (dn.count > 0) {
        ch.djen = true;
        c.djen_nova_comunicacao = true;
        c.djen_ultimo_resumo = dn.items && dn.items[0] ? dn.items[0].texto.slice(0, 300) : "";
        c.djen_ultima_data = dn.items && dn.items[0] ? dn.items[0].data : null;
        c.djen_ultimo_link = dn.items && dn.items[0] ? dn.items[0].link : null;
        c.djen_count = dn.count;
      }
      c.djen_consultado_em = hojeBR();
    }
    if (dj && dn && (!dj.ok || !dn.ok)) c.djen_nova_comunicacao = false;
    return ch;
  }
  function vereditoHtml(res) {
    var o = "";
    o += "CNJ: " + (res.cnj || "") + "\n";
    var dj = res.datajud, dn = res.djen;
    if (dj) { o += "\n--- DATAJUD ---\n"; o += djInfoHtml(dj); }
    if (dn) { o += "\n--- DJEN (comunicações) ---\n"; o += djenInfoHtml(dn); }
    if (res.error && !dj && !dn) o += (res.error || "") + "\n";
    return o;
  }
  function djInfoHtml(dj) {
    var o = "";
    if (dj && dj.ok) {
      o += "Tribunal: " + (dj.alias || "?").toUpperCase() + "\n";
      o += "Movimentos: " + dj.movimentosCount + "\n";
      o += "Último: " + (dj.ultimoNome || "—") + (dj.ultimoData ? " · " + dj.ultimoData : "") + "\n";
      if (dj.source) {
        o += "Situação: " + (dj.source.situacao || "—") + "\n";
        o += "Classe: " + (dj.source.classe || "—") + "\n";
        o += "Competência: " + (dj.source.competencia || "—") + "\n";
      }
      var movs = dj.movimentos || [];
      if (movs.length) {
        o += "\nÚltimos movimentos:\n";
        movs.slice(-8).forEach(function (m) {
          o += "  • " + (m.dataHora || m.data || "?") + " — " + (m.nome || m.descricao || m.text || "") + "\n";
        });
      }
    } else {
      o += (dj && dj.error ? "Erro: " + dj.error : "Sem retorno") + "\n";
    }
    return o;
  }
  function djenInfoHtml(dn) {
    var o = "";
    if (dn && dn.ok) {
      o += "Comunicações: " + dn.count + "\n";
      (dn.items || []).slice(0, 6).forEach(function (it) {
        o += "  • " + (it.data || "?") + " [" + (it.tipo || "?") + "] " + String(it.texto || "").slice(0, 160) + "\n";
      });
    } else {
      o += (dn && dn.error ? "Erro: " + dn.error : "Sem retorno") + "\n";
    }
    return o;
  }
  function scanToOut(out, res) {
    out.textContent = vereditoHtml(res);
    var c = rows.find(function (x) { return onlyDigits(x.protocolo) === onlyDigits(res.cnj); });
    if (c) {
      var ch = applyScanToCase(c, res);
      c._scannedThisRun = true;
      feedPush(scanLogLine(c, res, ch, 0));
      scheduleSave();
      renderAll();
      toast(scanToast(ch));
    }
    return c;
  }
  function scanToast(ch) {
    if (ch.closed) return "Caso atualizado · baixa no tribunal detectada";
    if (ch.alert) return "Caso atualizado · novo andamento";
    if (ch.djen) return "Caso atualizado · nova comunicação DJEN";
    return "Caso atualizado com o andamento.";
  }

  /* -------- motor de varredura (Scanner Omnipresente) -------- */
  var SCAN = {
    mode: "both", scope: "full",
    status: "idle", total: 0, done: 0, alerts: 0, djenAlerts: 0, closed: 0, errors: 0,
    queue: [], idx: 0, feed: []
  };
  var SCAN_LOG_KEY = "lexis_scan_event_log_v1";
  var SCAN_LOG_MAX = 200;
  var SCAN_PROG_KEY = "lexis_scan_progress";

  window.__scanPaused = false;
  function loadScanLogRows() {
    try { var r = localStorage.getItem(SCAN_LOG_KEY); return r ? JSON.parse(r) : []; } catch (e) { return []; }
  }
  function appendScanLogRow(row) {
    var arr = [Object.assign({ ts: new Date().toISOString() }, row)].concat(loadScanLogRows()).slice(0, SCAN_LOG_MAX);
    try { localStorage.setItem(SCAN_LOG_KEY, JSON.stringify(arr)); } catch (e) {}
  }
  function clearScanLogRows() {
    try { localStorage.removeItem(SCAN_LOG_KEY); } catch (e) {}
  }
  function readScanProgress() {
    try { return JSON.parse(localStorage.getItem(SCAN_PROG_KEY) || "null"); } catch (e) { return null; }
  }
  function writeScanProgress(done, total, mode) {
    try { localStorage.setItem(SCAN_PROG_KEY, JSON.stringify({ done: done, total: total, mode: mode, at: Date.now() })); } catch (e) {}
  }
  function clearScanProgress() {
    try { localStorage.removeItem(SCAN_PROG_KEY); } catch (e) {}
  }
  function scanDelayMs(streak) {
    if (streak > 8) return 3500;
    if (streak > 4) return 1600;
    if (streak > 1) return 900;
    return 450;
  }
  function scanShouldSkip(c) {
    if (c._scannedThisRun) return true;
    var djFresh = (SCAN.mode === "both" || SCAN.mode === "datajud") && c.datajud_consultado_em === hojeBR();
    var dnFresh = (SCAN.mode === "both" || SCAN.mode === "djen") && c.djen_consultado_em === hojeBR();
    return SCAN.mode === "both" ? (djFresh && dnFresh) : SCAN.mode === "datajud" ? djFresh : dnFresh;
  }
  function scanQueue() {
    var q = rows.filter(function (c) { return onlyDigits(c.protocolo).length === 20; });
    if (SCAN.scope === "cumprimento") {
      q = q.filter(function (c) {
        return c.is_procedente || c.em_cumprimento_sentenca || c.datajud_encerrado_tribunal ||
          /(procedente|cumprimento)/i.test(c.evento_resumo || "");
      });
    }
    return sortByPriority(q);
  }
  function scanModeLabel() {
    return SCAN.mode === "both" ? "Both" : SCAN.mode === "datajud" ? "DataJud" : "DJEN";
  }
  function scanLogLine(c, res, ch, latency) {
    var dj = res && res.datajud, dn = res && res.djen;
    var djOk = (SCAN.mode === "djen") ? true : !!(dj && dj.ok);
    var dnOk = (SCAN.mode === "datajud") ? true : !!(dn && dn.ok);
    var ok = djOk && dnOk;
    var msg = "";
    if (ch && ch.closed) msg = "Baixa/encerramento detectado no tribunal";
    else if (ch && ch.alert) msg = "Novo andamento: " + (dj && dj.ultimoNome || "");
    else if (ch && ch.djen) msg = "DJEN: " + (dn ? dn.count : 0) + " comunicação(ões) — " + (dn && dn.items && dn.items[0] ? String(dn.items[0].texto).slice(0, 140) : "");
    else if (dj && !dj.ok && dn && dn.ok) msg = "DataJud falhou · DJEN ok";
    else if (dj && dj.ok && !(dn && dn.ok) && SCAN.mode !== "datajud") msg = "DJEN falhou · DataJud ok";
    else if (dj && dj.ok && dj.ultimoNome) msg = String(dj.ultimoNome).slice(0, 160);
    else if (dn && dn.ok && dn.count) msg = "DJEN registrado";
    else if (!ok) msg = (dj && dj.error) || (dn && dn.error) || "Falha na fonte";
    else msg = "Monitoramento Regular";
    var type = ch && ch.closed ? "closed" : (ch && (ch.alert || ch.djen)) ? "update" : ok ? "ok" : "error";
    return { protocolo: c.protocolo, message: msg, latency: latency, success: ok, type: type, engine: "Local", source: scanModeLabel() };
  }
  function feedSys(msg, type) {
    feedPush({ protocolo: "SISTEMA", message: msg, latency: 0, success: true, type: type || "ok", engine: "Local", source: scanModeLabel() });
  }
  function feedPush(log) {
    SCAN.feed.unshift(log);
    if (SCAN.feed.length > 120) SCAN.feed = SCAN.feed.slice(0, 120);
    renderScanFeed();
  }
  function startLocalScan(resume) {
    if (SCAN.status === "running") return;
    var saved = resume ? readScanProgress() : null;
    if (!resume) { clearScanProgress(); SCAN.alerts = 0; SCAN.djenAlerts = 0; SCAN.closed = 0; SCAN.errors = 0; SCAN.done = 0; }
    if (!window.lexisOffline) { SCAN.status = "idle"; renderScanUI(); return toast("Abra pelo EXE", "err-msg"); }
    var q = scanQueue();
    if (!q.length) {
      SCAN.status = "idle"; renderScanUI();
      feedSys("Nenhum processo com CNJ válido (20 dígitos)" + (SCAN.scope === "cumprimento" ? " no escopo cumprimento — rode Full" : "") , "error");
      return toast("Nenhum CNJ válido na fila", "err-msg");
    }
    SCAN.queue = q; SCAN.total = q.length;
    SCAN.idx = 0;
    if (resume && saved && saved.total === q.length && saved.done >= 0 && saved.done <= q.length) {
      SCAN.idx = saved.done; SCAN.done = saved.done;
      feedPush({ protocolo: "SISTEMA", message: "Retomando da posição " + (SCAN.idx + 1) + "/" + q.length, latency: 0, success: true, type: "ok", engine: "Local", source: scanModeLabel() });
    } else {
      feedSys((SCAN.scope === "cumprimento" ? "Escopo CUMPRIMENTO: " : "Carteira full: ") + q.length + " CNJ(s) na fila · " + scanModeLabel());
    }
    SCAN.status = "running";
    renderScanUI();
    scanLoop();
  }
  function scanLoop() {
    (function step() {
      if (SCAN.status !== "running") return;
      if (SCAN.idx >= SCAN.queue.length) {
        SCAN.status = "done"; clearScanProgress();
        feedSys("Varredura concluída: " + SCAN.done + " CNJ(s) · DJ " + SCAN.alerts + " alerta(s) · DJEN " + SCAN.djenAlerts + " · encerrado(s) " + SCAN.closed + " · erro(s) " + SCAN.errors, "ok");
        scheduleSave(); renderAll(); renderScanUI();
        return;
      }
      var c = SCAN.queue[SCAN.idx];
      if (scanShouldSkip(c)) {
        SCAN.idx++; SCAN.done++;
        feedPush({ protocolo: c.protocolo, message: "Pulado: auditado hoje", latency: 0, success: true, type: "ok", engine: "Local", source: scanModeLabel() });
        appendScanLogRow({ cnj: c.protocolo, motor: SCAN.mode, ok: true, detalhe: "skip-hoje" });
        renderScanUI();
        setTimeout(step, 25);
        return;
      }
      var start = Date.now();
      runScanMode(c.protocolo, SCAN.mode).then(function (res) {
        var latency = Date.now() - start;
        var ch = applyScanToCase(c, res);
        c._scannedThisRun = true;
        if (ch.closed) SCAN.closed++;
        if (ch.alert) SCAN.alerts++;
        if (ch.djen) SCAN.djenAlerts++;
        var dj = res && res.datajud, dn = res && res.djen;
        var djOk = (SCAN.mode === "djen") ? true : !!(dj && dj.ok);
        var dnOk = (SCAN.mode === "datajud") ? true : !!(dn && dn.ok);
        if (!djOk || !dnOk) SCAN.errors++; else SCAN.failStreak = 0;
        var log = scanLogLine(c, res, ch, latency);
        feedPush(log);
        appendScanLogRow({ cnj: c.protocolo, motor: SCAN.mode, ok: log.success, detalhe: String(log.message).slice(0, 120) });
        SCAN.idx++; SCAN.done++;
        writeScanProgress(SCAN.done, SCAN.total, SCAN.mode);
        if (SCAN.done % 10 === 0) {
          feedSys("Progresso " + SCAN.done + "/" + SCAN.total + " · DJ " + SCAN.alerts + " · DJEN " + SCAN.djenAlerts + " · erros " + SCAN.errors);
          scheduleSave(); // grava o progresso real de tempos em tempos (não a cada CNJ)
        }
        renderScanUI();
        setTimeout(step, scanDelayMs(SCAN.errors));
      }).catch(function (e) {
        SCAN.errors++;
        var msg = (e && e.message) || String(e);
        feedPush({ protocolo: c.protocolo, message: msg, latency: Date.now() - start, success: false, type: "error", engine: "Local", source: scanModeLabel() });
        appendScanLogRow({ cnj: c.protocolo, motor: SCAN.mode, ok: false, detalhe: String(msg).slice(0, 120) });
        SCAN.idx++; SCAN.done++;
        writeScanProgress(SCAN.done, SCAN.total, SCAN.mode);
        renderScanUI();
        setTimeout(step, scanDelayMs(SCAN.errors));
      });
    })();
  }

  /* -------- render scanner UI -------- */
  function renderScanUI() {
    var rs = document.querySelectorAll('input[name="scMode"]');
    rs.forEach(function (r) { r.checked = (r.value === SCAN.mode); });
    var ef = $("scScopeFull"), ec = $("scScopeCumpr");
    if (ef) ef.className = "btn" + (SCAN.scope === "full" ? " btn-pri" : "");
    if (ec) ec.className = "btn" + (SCAN.scope === "cumprimento" ? " btn-pri" : "");
    var st = $("scStatus");
    if (st) {
      st.textContent = SCAN.status === "running" ? "varrendo…" : SCAN.status === "paused" ? "pausado" : SCAN.status === "done" ? "concluído" : "ocioso";
      st.className = "pill " + (SCAN.status === "running" ? "warn" : SCAN.status === "done" ? "ok" : "");
    }
    var pct = SCAN.total ? Math.round((SCAN.done / SCAN.total) * 100) : 0;
    var pr = $("scProg");
    if (pr) { pr.innerHTML = '<div style="width:' + Math.max(3, pct) + '%;background:var(--primary)"></div>'; }
    function setv(id, v) { var el = $(id); if (el) el.textContent = v; }
    setv("scA", SCAN.alerts);
    setv("scD", SCAN.djenAlerts);
    setv("scC", SCAN.closed);
    setv("scE", SCAN.errors);
    setv("scF", SCAN.done + "/" + SCAN.total);
    var bl = $("btnScanLocal");
    if (bl) {
      bl.style.display = "inline-flex";
      bl.disabled = SCAN.status === "running";
      bl.textContent = SCAN.status === "done" ? "Iniciar nova varredura" : "Iniciar Varredura Local";
    }
    var bp = $("btnScanPause");
    if (bp) {
      bp.disabled = !(SCAN.status === "running" || SCAN.status === "paused");
      bp.textContent = SCAN.status === "paused" ? "Retomar" : "Pausar";
    }
    var qi = $("scQueueInfo");
    if (qi) {
      var n = rows.filter(function (c) { return onlyDigits(c.protocolo).length === 20; }).length;
      qi.textContent = (SCAN.scope === "cumprimento" ? "Escopo: só cumprimento (procedente / em cumprimento / baixa no tribunal). " : "Escopo: carteira completa. ") + n + " processo(s) com CNJ válido na carteira.";
    }
    var cur = $("scCur");
    if (cur) cur.textContent = scanModeLabel() + " · " + (SCAN.scope === "cumprimento" ? "CUMPRIMENTO" : "FULL");
  }
  function renderScanFeed() {
    var f = $("scanFeed");
    if (!f) return;
    if (!SCAN.feed.length) {
      f.innerHTML = '<div class="empty"><b>Aguardando telemetria</b>Inicie a varredura local para ver os logs ao vivo.</div>';
      return;
    }
    f.innerHTML = SCAN.feed.slice(0, 40).map(function (l) {
      var ic = l.type === "closed" ? "⚖" : l.type === "update" ? "⚡" : l.type === "error" ? "✕" : l.type === "ai" ? "◇" : "✓";
      var badge = l.source === "DJEN" ? "b-hoje" : l.type === "error" ? "b-ven" : l.type === "update" ? "b-aten" : "b-ok";
      var cls = l.type === "error" ? "style='color:var(--vencido)'" : "";
      return '<div class="sc-log"><div class="sc-log-ic">' + ic + '</div><div class="sc-log-bd"><b>' + esc(l.protocolo) + '</b> <span class="badge ' + badge + '">' + esc(l.source || "Both") + "</span><span " + cls + ">" + esc(l.message) + '</span></div><div class="sc-log-ms">' + l.latency + "ms</div></div>";
    }).join("");
  }
  function renderLogs() {
    var rows2 = loadScanLogRows();
    var cnt = $("scLogCount"); if (cnt) cnt.textContent = rows2.length + (rows2.length >= SCAN_LOG_MAX ? "+" : "");
    var box = $("scLogList");
    if (!box) return;
    if (!rows2.length) { box.textContent = "Sem logs ainda. Rode uma varredura local para registrar cada CNJ consultado."; return; }
    box.textContent = rows2.map(function (r) {
      var t = (r.ts || "").replace("T", " ").slice(0, 19);
      return t + "  " + (r.motor || "?") + "  " + (r.ok ? "OK " : "FALHA") + "  " + (r.cnj || "") + (r.detalhe ? "  —  " + r.detalhe : "");
    }).join("\n");
  }
  function exportScanLogCsv() {
    var rows2 = loadScanLogRows();
    var head = "hora,cnj,motor,ok,detalhe";
    var body = rows2.map(function (r) {
      return [r.ts, r.cnj || "", r.motor || "", r.ok ? "ok" : "falha", JSON.stringify(r.detalhe || "")].join(",");
    });
    var csv = [head].concat(body).join("\n");
    if (window.lexisOffline && window.lexisOffline.exportCsvFile) {
      window.lexisOffline.exportCsvFile(csv, "scan-log-" + hojeBR() + ".csv").then(function () { toast("Logs exportados"); });
    } else {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      a.download = "scan-log.csv"; a.click();
    }
  }
  function scanTab(name) {
    var show = name === "logs" ? "logs" : "varredura";
    ["varredura", "logs"].forEach(function (t) {
      var el = $("sctab-" + t); if (el) el.style.display = t === show ? "block" : "none";
    });
    document.querySelectorAll(".sc-tab").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-sctab") === show);
    });
    if (show === "logs") renderLogs(); else renderScanUI();
  }

  /* ============================ dossiê ============================ */
  function buildDossier() {
    if (!rows.length) {
      return '<div style="border:1px solid var(--border);border-radius:16px;background:var(--card);padding:48px;text-align:center">' +
        '<div style="width:64px;height:64px;background:var(--primary-soft);border-radius:999px;display:flex;align-items:center;justify-content:center;margin:0 auto 24px;font-size:28px">📋</div>' +
        '<div style="font-size:18px;font-weight:900;margin-bottom:8px">Nenhum processo carregado</div>' +
        '<div style="font-size:12px;color:var(--muted);margin-bottom:24px">Importe a planilha em <b>Importar</b> ou cadastre processos em <b>Cadastro</b> antes de gerar o relatório.</div>' +
        '<button class="btn btn-pri" onclick="nav(\"import\")" style="margin:0 auto">Ir para Importar</button>' +
        '</div>';
    }
    var k = kpisAll();
    var risk = computeRisk(k);
    var hoje = hojeBR();
    var session = window.__lexisSession || {};
    var operador = session.nome || cfg.oper || "—";
    var now = new Date();
    var dataStr = now.toLocaleDateString("pt-BR");
    var horaStr = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    function ec(s) { return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
    function badge(st) {
      var cls = "color:#64748b";
      if (st === "Vencido" || st === "Caso Critico") cls = "color:#ef4444";
      else if (st === "Hoje") cls = "color:#3b82f6";
      else if (st === "Atencao") cls = "color:#f97316";
      else if (st === "No Prazo") cls = "color:#10b981";
      return '<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;background:rgba(0,0,0,.06);' + cls + '">' + ec(st) + '</span>';
    }
    function prioBadge(c) {
      var f = faixaPrioridade(pesoFila(c));
      return '<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;background:rgba(0,0,0,.06)">' + ec(f[0]) + '</span>';
    }
    var riskColor = risk.score >= 80 ? "#dc2626" : risk.score >= 60 ? "#ef4444" : risk.score >= 40 ? "#f97316" : risk.score >= 20 ? "#eab308" : "#10b981";
    var crit = sortByPriority(rows.filter(function(c) { var st = statusDe(c); return st === "Vencido" || st === "Hoje" || st === "Caso Critico"; }));
    var week = rows.filter(function(c) { var st = statusDe(c); if (st === "Arquivado") return false; var d = diasAte(c.proximoPrazo); return d !== null && d >= 0 && d <= 7; });
    var par = rows.filter(function(c) { var st = statusDe(c); if (st === "Arquivado") return false; var d = diasDesde(c.ultimoRetorno || c.data_distribuicao); return d === null || d >= 60; });
    var novas = rows.filter(function(c) { return (c.tem_novo_andamento || c.djen_nova_comunicacao) && statusDe(c) !== "Arquivado"; });
    var cumpr = rows.filter(function(c) { return c.em_cumprimento_sentenca; });
    var proc = rows.filter(function(c) { return c.is_procedente; });
    var improc = rows.filter(function(c) { return c.is_improcedente; });
    var atendidosSemana = rows.filter(function(c) { if (!c.ultimoRetorno || statusDe(c) === "Arquivado") return false; var d = diasDesde(c.ultimoRetorno); return d !== null && d >= 0 && d <= 7; });
    var recs = [];
    if (k.venc) recs.push("Priorizar revisao de " + k.venc + " prazo(s) vencido(s).");
    if (k.hoje) recs.push("Acompanhar " + k.hoje + " caso(s) com prazo hoje.");
    if (k.nov) recs.push("Responder " + k.nov + " novidade(s) de andamento.");
    if (k.baixa) recs.push("Confirmar " + k.baixa + " baixa(s) do tribunal.");
    if (par.length) recs.push("Auditar " + par.length + " processo(s) parado(s).");
    if (cumpr.length) recs.push("Impulsionar " + cumpr.length + " caso(s) em cumprimento.");
    if (recs.length === 0) recs.push("Carteira estavel: manter rotina de acompanhamento.");
    var h = "";
    h += '<div style="border:1px solid var(--border);border-radius:16px;background:var(--card);padding:40px 48px;margin-bottom:32px;position:relative;overflow:hidden">';
    h += '<div style="position:absolute;top:-20px;right:-20px;opacity:.04;font-size:200px;color:var(--primary)">&#9830;</div>';
    h += '<div style="display:flex;align-items:center;gap:16px;margin-bottom:32px">';
    h += '<div style="width:48px;height:48px;background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center;border-radius:10px;font-size:24px;font-weight:900">L</div>';
    h += '<div><div style="font-size:14px;font-weight:900;letter-spacing:.15em;text-transform:uppercase">LexisPredict Elite</div>';
    h += '<div style="font-size:9px;font-weight:700;color:var(--muted);letter-spacing:.1em;text-transform:uppercase">W1 Capital \u00b7 Advanced Legal Operations</div></div></div>';
    h += '<h1 style="font-size:36px;font-weight:900;letter-spacing:-.03em;line-height:1;margin:0 0 8px;text-transform:uppercase">Dossi\u00ea<br>Operacional<br><span style="color:var(--primary)">Master</span></h1>';
    h += '<p style="font-size:9px;font-weight:700;color:var(--muted);letter-spacing:.2em;text-transform:uppercase;margin:12px 0 0">Relatorio Consolidado de Merito e Responsabilidade</p>';
    h += '<div style="display:flex;justify-content:space-between;align-items:flex-end;border-top:2px solid var(--border);margin-top:32px;padding-top:20px">';
    h += '<div><div style="font-size:9px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.1em">Auditado por</div>';
    h += '<div style="font-size:16px;font-weight:900;text-transform:uppercase">' + ec(operador) + '</div></div>';
    h += '<div style="text-align:right"><div style="font-size:20px;font-weight:900;letter-spacing:-.02em">' + now.getFullYear() + '</div>';
    h += '<div style="font-size:8px;font-weight:800;color:var(--muted);border:1px solid var(--border);padding:2px 8px;border-radius:4px;display:inline-block">v.6.2 ELITE</div></div></div></div>';
    h += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:32px">';
    function kpiCard(label, value, color) {
      return '<div style="border:1px solid var(--border);border-radius:12px;padding:16px;background:var(--card)"><div style="font-size:9px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px">' + label + '</div><div style="font-size:28px;font-weight:900;font-variant-numeric:tabular-nums;' + (color ? 'color:' + color : '') + '">' + value + '</div></div>';
    }
    h += kpiCard("Ativos em Gestao", k.ativos);
    h += kpiCard("Atendidos Semana", atendidosSemana.length, "#3b82f6");
    h += kpiCard("Vencidos / Hoje", k.venc + " / " + k.hoje, "#ef4444");
    h += kpiCard("Risco Carteira", risk.score + "%", riskColor);
    h += kpiCard("Novidades", k.nov, k.nov ? "#a855f7" : "");
    h += kpiCard("Baixas Tribunal", k.baixa, k.baixa ? "#10b981" : "");
    h += kpiCard("Procedentes", k.proc, "#10b981");
    h += kpiCard("Improcedentes", k.improc, "#ef4444");
    h += kpiCard("Cumprimento", cumpr.length, "#3b82f6");
    h += kpiCard("Parados 60d+", par.length, par.length ? "#f97316" : "");
    h += kpiCard("Sem Prazo", k.sem, "#94a3b8");
    h += kpiCard("Arquivados", k.arq, "#64748b");
    h += '</div>';
    h += '<div style="border:1px solid var(--border);border-radius:16px;background:var(--card);padding:24px;margin-bottom:32px">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px"><div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)">Indice de Risco</div>';
    h += '<div style="font-size:10px;font-weight:800;padding:4px 12px;border-radius:999px;background:' + riskColor + ';color:#fff;text-transform:uppercase">' + risk.label + '</div></div>';
    h += '<div style="height:12px;background:var(--elev);border-radius:999px;overflow:hidden;margin-bottom:8px"><div style="height:100%;width:' + Math.max(4, risk.score) + '%;background:' + riskColor + ';border-radius:999px"></div></div>';
    h += '<div style="font-size:10px;font-weight:800;color:var(--muted)">' + risk.score + '/100</div></div>';
    h += '<div style="border:1px solid var(--border);border-radius:16px;background:var(--card);overflow:hidden;margin-bottom:32px">';
    h += '<div style="background:var(--primary);color:#fff;padding:16px 24px;display:flex;justify-content:space-between;align-items:center">';
    h += '<div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em">Resumo Executivo</div>';
    h += '<div style="font-size:9px;font-weight:800;padding:4px 12px;border-radius:999px;background:rgba(255,255,255,.2)">Risco ' + risk.label + ' \u00b7 ' + risk.score + '%</div></div>';
    h += '<div style="padding:24px;display:grid;grid-template-columns:1fr 1fr;gap:24px">';
    h += '<div><div style="font-size:9px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px">Leitura da Carteira</div>';
    h += '<div style="font-size:11px;font-weight:600;line-height:1.8">';
    h += '<div><b>' + k.venc + '</b> prazo(s) vencido(s) e <b>' + k.hoje + '</b> para hoje.</div>';
    h += '<div><b>' + k.nov + '</b> caso(s) com novidade de andamento.</div>';
    h += '<div><b>' + k.baixa + '</b> baixa(s) do tribunal.</div>';
    h += '<div><b>' + par.length + '</b> processo(s) parado(s).</div></div></div>';
    h += '<div><div style="font-size:9px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px">Plano de Acao</div>';
    h += '<ol style="font-size:11px;font-weight:600;line-height:1.8;padding-left:16px;margin:0">';
    recs.slice(0,6).forEach(function(r,i){h+='<li>'+ec(r)+'</li>';});
    h += '</ol></div></div></div>';
    if (crit.length) {
      h += '<div style="border:1px solid var(--border);border-radius:16px;background:var(--card);overflow:hidden;margin-bottom:32px">';
      h += '<div style="background:#1e293b;color:#fff;padding:16px 24px"><div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em">Fila Critica \u00b7 ' + crit.length + ' caso(s)</div></div>';
      h += '<table style="width:100%;border-collapse:collapse;font-size:10px"><thead><tr style="background:var(--elev);border-bottom:1px solid var(--border)">';
      ['Cliente / Protocolo','Status','Prazo','Dias','Prioridade'].forEach(function(c){h+='<th style="padding:10px 16px;text-align:left;font-size:9px;font-weight:800;text-transform:uppercase;color:var(--muted)">'+c+'</th>';});
      h += '</tr></thead><tbody>';
      crit.slice(0,20).forEach(function(c){var st=statusDe(c);var d=diasAte(c.proximoPrazo);var ds=d===null?'\u2014':(d<0?'VENCIDO '+Math.abs(d)+'d':d+'d');var dc=d!==null&&d<0?'#ef4444':d===0?'#3b82f6':'var(--muted)';
        h+='<tr style="border-bottom:1px solid var(--border)"><td style="padding:10px 16px"><div style="font-weight:800;font-size:11px">'+ec(c.cliente||'\u2014')+'</div><div style="font-size:9px;color:var(--muted);font-family:monospace">'+ec(c.protocolo||'')+'</div></td>';
        h+='<td style="padding:10px 16px">'+badge(st)+'</td><td style="padding:10px 16px;font-variant-numeric:tabular-nums;font-weight:700">'+ec(c.proximoPrazo||'\u2014')+'</td>';
        h+='<td style="padding:10px 16px;font-weight:800;color:'+dc+'">'+ds+'</td><td style="padding:10px 16px">'+prioBadge(c)+'</td></tr>';});
      h += '</tbody></table></div>';
    }
    var topChance=rows.filter(function(c){return statusDe(c)!=='Arquivado'&&c.proximoPrazo;}).sort(function(a,b){return(diasAte(a.proximoPrazo)||999)-(diasAte(b.proximoPrazo)||999);}).slice(0,10);
    if(topChance.length){h+='<div style="border:1px solid var(--border);border-radius:16px;background:var(--card);overflow:hidden;margin-bottom:32px"><div style="background:#059669;color:#fff;padding:16px 24px"><div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em">Top 10: Maior Proximidade de Encerramento</div></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:0">';
      topChance.forEach(function(c){var d=diasAte(c.proximoPrazo);h+='<div style="padding:14px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center"><div><div style="font-size:10px;font-weight:800;text-transform:uppercase">'+ec(c.cliente||'\u2014')+'</div><div style="font-size:9px;color:var(--muted);font-family:monospace">'+ec(c.protocolo||'')+'</div></div><div style="text-align:right"><div style="font-size:18px;font-weight:900;color:#059669">'+(d===null?'\u2014':d+'d')+'</div><div style="font-size:8px;font-weight:800;color:var(--muted);text-transform:uppercase">Restante</div></div></div>';});
      h+='</div></div>';
    }
    if(par.length){h+='<div style="border:1px solid var(--border);border-radius:16px;background:var(--card);overflow:hidden;margin-bottom:32px"><div style="background:#f97316;color:#fff;padding:16px 24px"><div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em">Processos Parados \u2265 60 Dias \u00b7 '+par.length+' caso(s)</div></div><div style="padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:8px">';
      par.slice(0,12).forEach(function(c){var d=diasDesde(c.ultimoRetorno||c.data_distribuicao);h+='<div style="border:1px solid var(--border);border-radius:10px;padding:12px;display:flex;justify-content:space-between;align-items:center"><div><div style="font-size:10px;font-weight:800;text-transform:uppercase">'+ec(c.cliente||'\u2014')+'</div><div style="font-size:9px;color:var(--muted);font-family:monospace">'+ec(c.protocolo||'')+'</div></div><div style="font-size:12px;font-weight:900;color:#f97316">'+(d===null?'sem reg.':d+'d')+'</div></div>';});
      h+='</div></div>';
    }
    h+='<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:32px">';
    function meritCol(title,list,color){var m='<div style="border:1px solid var(--border);border-radius:12px;background:var(--card);overflow:hidden"><div style="background:'+color+';color:#fff;padding:10px 14px;display:flex;justify-content:space-between;align-items:center"><span style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em">'+title+'</span><span style="font-size:9px;font-weight:800;background:rgba(255,255,255,.2);padding:2px 8px;border-radius:999px">'+list.length+'</span></div><div style="padding:12px;max-height:200px;overflow:auto">';list.slice(0,10).forEach(function(c){m+='<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:10px"><div style="font-weight:800;text-transform:uppercase">'+ec(c.cliente||'\u2014')+'</div><div style="font-size:9px;color:var(--muted);font-family:monospace">'+ec(c.protocolo||'')+'</div></div>';});if(!list.length)m+='<div style="padding:20px;text-align:center;font-size:9px;color:var(--muted);text-transform:uppercase;font-weight:800">Nenhum caso</div>';m+='</div></div>';return m;}
    h+=meritCol('Fase Executiva',cumpr,'#3b82f6');h+=meritCol('Procedentes',proc,'#10b981');h+=meritCol('Improcedentes',improc,'#ef4444');h+='</div>';
    if(week.length){h+='<div style="border:1px solid var(--border);border-radius:16px;background:var(--card);overflow:hidden;margin-bottom:32px"><div style="background:var(--card);border-bottom:1px solid var(--border);padding:16px 24px"><div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em">Proximos 7 Dias \u00b7 '+week.length+' caso(s)</div></div><table style="width:100%;border-collapse:collapse;font-size:10px"><thead><tr style="background:var(--elev);border-bottom:1px solid var(--border)">';
      ['Cliente','Prazo','Dias','Prioridade'].forEach(function(c){h+='<th style="padding:8px 16px;text-align:left;font-size:9px;font-weight:800;text-transform:uppercase;color:var(--muted)">'+c+'</th>';});
      h+='</tr></thead><tbody>';sortByPriority(week).slice(0,15).forEach(function(c){var d=diasAte(c.proximoPrazo);h+='<tr style="border-bottom:1px solid var(--border)"><td style="padding:8px 16px;font-weight:700">'+ec(c.cliente||'\u2014')+'</td><td style="padding:8px 16px;font-variant-numeric:tabular-nums">'+ec(c.proximoPrazo||'\u2014')+'</td><td style="padding:8px 16px;font-weight:800;color:'+(d!==null&&d<=1?'#ef4444':'#f97316')+'">'+(d===null?'\u2014':d+'d')+'</td><td style="padding:8px 16px">'+prioBadge(c)+'</td></tr>';});
      h+='</tbody></table></div>';
    }
    if(novas.length){h+='<div style="border:1px solid var(--border);border-radius:16px;background:var(--card);overflow:hidden;margin-bottom:32px"><div style="background:#a855f7;color:#fff;padding:16px 24px"><div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em">Novidades \u00b7 '+novas.length+' caso(s) com andamento novo / DJEN</div></div><div style="padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:8px">';
      novas.slice(0,10).forEach(function(c){h+='<div style="border:1px solid var(--border);border-radius:10px;padding:12px"><div style="font-size:10px;font-weight:800;text-transform:uppercase">'+ec(c.cliente||'\u2014')+'</div><div style="font-size:9px;color:var(--muted);font-family:monospace">'+ec(c.protocolo||'')+'</div>';if(c.evento_resumo)h+='<div style="font-size:9px;color:#a855f7;margin-top:4px;font-weight:700">'+ec(c.evento_resumo)+'</div>';h+='</div>';});
      h+='</div></div>';
    }
    h+='<div style="border:1px solid var(--border);border-radius:16px;background:var(--card);padding:24px;display:flex;justify-content:space-between;align-items:center;margin-top:32px"><div style="display:flex;align-items:center;gap:12px"><div style="width:36px;height:36px;border:2px solid var(--primary);border-radius:8px;display:flex;align-items:center;justify-content:center;background:var(--primary);color:#fff;font-weight:900">L</div><div><div style="font-size:9px;letter-spacing:.15em;text-transform:uppercase;font-weight:900">2026 W1 CAPITAL \u00b7 AUTHORITY SYSTEM</div><div style="font-size:8px;color:var(--muted);letter-spacing:.08em;text-transform:uppercase">Dossi\u00ea Operacional \u00b7 Lexis Gabinete v6.2</div></div></div><div style="text-align:right"><div style="font-size:9px;font-weight:800;color:var(--muted)">'+dataStr+' \u00b7 '+horaStr+'</div><div style="font-size:8px;font-weight:700;color:var(--muted)">Gerado por '+ec(operador)+'</div></div></div>';
    return h;
  }

  /* DEAD CODE BELOW - REMOVED */
  if (false) {
    t += "REMOVEME_START";
    t += "║        DOSSIÊ OPERACIONAL · LEXIS GABINETE v6.2         ║\n";
    t += "║        Data: " + hoje + "  ·  Operador: " + operador + "          ║\n";
    t += "╚══════════════════════════════════════════════════════════╝\n\n";

    t += "┌─────────────────────────────────────────────────────────┐\n";
    t += "│  RESUMO EXECUTIVO                                      │\n";
    t += "├─────────────────────────────────────────────────────────┤\n";
    t += "│  Carteira total:     " + String(k.total).padStart(6) + "                           │\n";
    t += "│  Ativos:             " + String(k.ativos).padStart(6) + "                           │\n";
    t += "│  Vencidos:           " + String(k.venc).padStart(6) + "  ◄ CRÍTICO                  │\n";
    t += "│  É hoje:             " + String(k.hoje).padStart(6) + "  ◄ URGENTE                  │\n";
    t += "│  Atenção (≤3d):      " + String(k.aten).padStart(6) + "                           │\n";
    t += "│  Sem prazo:          " + String(k.sem).padStart(6) + "                           │\n";
    t += "│  Arquivados:         " + String(k.arq).padStart(6) + "                           │\n";
    t += "│  Atendidos hoje:     " + String(k.atendidosHoje).padStart(6) + "                           │\n";
    t += "│  Novidades (DJEN):   " + String(k.nov).padStart(6) + "                           │\n";
    t += "│  Baixas tribunal:    " + String(k.baixa).padStart(6) + "                           │\n";
    t += "│  Procedentes:        " + String(k.proc).padStart(6) + "                           │\n";
    t += "│  Improcedentes:      " + String(k.improc).padStart(6) + "                           │\n";
    t += "│  Risco global:       " + String(risk.score).padStart(3) + "/100  (" + risk.label + ")          │\n";
    t += "└─────────────────────────────────────────────────────────┘\n\n";

    // Barra de risco visual
    var barLen = 40;
    var filled = Math.round((risk.score / 100) * barLen);
    var bar = "[" + "█".repeat(filled) + "░".repeat(barLen - filled) + "]";
    t += "  RISCO: " + bar + " " + risk.score + "%\n\n";

    // Fila crítica
    var crit = sortByPriority(rows.filter(function (c) {
      var st = statusDe(c); return st === "Vencido" || st === "É Hoje" || st === "Caso Crítico";
    }));
    if (crit.length) {
      t += "┌─────────────────────────────────────────────────────────┐\n";
      t += "│  FILA CRÍTICA · " + crit.length + " caso(s)                            │\n";
      t += "├─────────────────────────────────────────────────────────┤\n";
      crit.slice(0, 30).forEach(function (c, i) {
        var f = faixaPrioridade(pesoFila(c));
        var st = statusDe(c);
        var dias = diasAte(c.proximoPrazo);
        var diasStr = dias === null ? "—" : (dias < 0 ? "VENCIDO " + Math.abs(dias) + "d" : dias + "d");
        t += "│ " + String(i + 1).padStart(2) + ". " + (st === "Vencido" ? "🔴" : st === "É Hoje" ? "🔵" : "⚠️") + " " + (c.cliente || "—").substring(0, 35).padEnd(35) + " │\n";
        t += "│     " + (c.protocolo || "—") + "  │  Prazo: " + (c.proximoPrazo || "—") + "  │  " + diasStr + "     │\n";
        if (c.telefone) t += "│     📞 " + c.telefone + "                                        │\n";
        if (c.observacao) t += "│     📝 " + c.observacao.substring(0, 50) + "                      │\n";
        t += "│     ─────────────────────────────────────────────────── │\n";
      });
      t += "└─────────────────────────────────────────────────────────┘\n\n";
    }

    // Atenção (próximos 7 dias)
    var week = rows.filter(function (c) {
      var st = statusDe(c); if (st === "Arquivado") return false;
      var d = diasAte(c.proximoPrazo); return d !== null && d >= 0 && d <= 7;
    });
    if (week.length) {
      t += "┌─────────────────────────────────────────────────────────┐\n";
      t += "│  PRÓXIMOS 7 DIAS · " + week.length + " caso(s)                          │\n";
      t += "├─────────────────────────────────────────────────────────┤\n";
      sortByPriority(week).slice(0, 15).forEach(function (c) {
        var dias = diasAte(c.proximoPrazo);
        t += "│  📅 " + (c.proximoPrazo || "—") + "  │  " + (c.cliente || "—").substring(0, 30).padEnd(30) + "  │  " + (dias === null ? "—" : dias + "d") + "  │\n";
      });
      t += "└─────────────────────────────────────────────────────────┘\n\n";
    }

    // Parados
    var par = rows.filter(function (c) {
      var st = statusDe(c); if (st === "Arquivado") return false;
      var d = diasDesde(c.ultimoRetorno || c.data_distribuicao);
      return d === null || d >= 60;
    });
    if (par.length) {
      t += "┌─────────────────────────────────────────────────────────┐\n";
      t += "│  ⚠ PROCESSOS PARADOS ≥ 60 DIAS · " + par.length + " caso(s)              │\n";
      t += "├─────────────────────────────────────────────────────────┤\n";
      par.slice(0, 15).forEach(function (c) {
        var d = diasDesde(c.ultimoRetorno || c.data_distribuicao);
        t += "│  🔴 " + (c.cliente || "—").substring(0, 35).padEnd(35) + " │ " + (d === null ? "sem registro" : d + " dias") + "  │\n";
      });
      t += "└─────────────────────────────────────────────────────────┘\n\n";
    }

    // Novidades
    var novas = rows.filter(function (c) {
      return (c.tem_novo_andamento || c.djen_nova_comunicacao) && statusDe(c) !== "Arquivado";
    });
    if (novas.length) {
      t += "┌─────────────────────────────────────────────────────────┐\n";
      t += "│  🆕 NOVIDADES (andamento novo / DJEN) · " + novas.length + " caso(s)    │\n";
      t += "├─────────────────────────────────────────────────────────┤\n";
      novas.slice(0, 10).forEach(function (c) {
        t += "│  ⚡ " + (c.cliente || "—").substring(0, 35).padEnd(35) + " │\n";
        if (c.evento_resumo) t += "│     " + c.evento_resumo.substring(0, 50) + "                        │\n";
      });
      t += "└─────────────────────────────────────────────────────────┘\n\n";
    }

    t += "══════════════════════════════════════════════════════════\n";
    t += "  Gerado automaticamente por Lexis Gabinete v6.2\n";
    t += "  W1 Capital Assessoria Financeira Ltda\n";
    t += "  " + new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) + "\n";
    t += "══════════════════════════════════════════════════════════\n";
    return t;
  }

  /* ============================ export ============================ */
  function exportCsv() {
    var head = "cliente,protocolo,telefone,tribunal,advogado,escritorio,situacao,ultimo_retorno,proximo_prazo,status,observacao\n";
    var lines = rows.map(function (c) {
      function q(s) { return '"' + String(s || "").replace(/"/g, '""') + '"'; }
      return [q(c.cliente), q(c.protocolo), q(c.telefone), q(c.tribunal), q(c.advogado), q(c.escritorio), q(c.situacao), q(c.ultimoRetorno || ""), q(c.proximoPrazo || ""), q(statusDe(c)), q(c.observacao)].join(",");
    });
    return head + lines.join("\n");
  }
  function saveCsvToDisk() {
    var csv = exportCsv();
    if (window.lexisOffline && window.lexisOffline.exportCsvFile) {
      window.lexisOffline.exportCsvFile(csv, "lexis-carteira.csv").then(function () { toast("CSV exportado"); });
    } else {
      var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "lexis-carteira.csv";
      a.click();
    }
  }

  /* ============================ eventos globais ============================ */
  function bindNav() {
    document.querySelectorAll(".nav").forEach(function (b) {
      b.addEventListener("click", function () { nav(b.getAttribute("data-nav")); });
    });
  }
  function bindCommon() {
    $("btnSaveDisk").onclick = $("btnSaveDisk2").onclick = function () {
      saveNow();
      toast("Salvo no PC (lexis-offline-db.json)");
    };
    $("btnLoadDisk").onclick = function () {
      loadFromDisk().catch(function () { toast("Falha ao carregar config local"); });
    };
    $("btnClear").onclick = function () {
      if (!confirm("Limpar TODA a carteira local?")) return;
      rows = []; notes = []; outbox = [];
      scheduleSave();
      renderAll();
      toast("Carteira limpa");
    };
    $("btnSync").onclick = $("btnSync2").onclick = function () { syncAll(); };
    $("btnSidebar").onclick = function () {
      var s = $("side");
      s.classList.toggle("collapsed");
      $("btnSidebar").textContent = s.classList.contains("collapsed") ? "› abrir" : "‹ recolher";
    };
    $("btnTheme").onclick = function () {
      document.documentElement.classList.toggle("dark");
      try { localStorage.setItem(LS.theme, document.documentElement.classList.contains("dark") ? "dark" : "light"); } catch (e) {}
    };
    $("btnExportCsv").onclick = saveCsvToDisk;
    $("btnOpenCsvFolder").onclick = saveCsvToDisk;
  }
  function bindImport() {
    $("btnSheets").onclick = function () {
      var url = $("sheetsUrl").value.trim() || cfg.url;
      if (!url) return toast("Cole o link da planilha");
      cfg.url = url; saveCfg();
      var st = $("sheetsStatus");
      st.textContent = "Baixando…"; st.className = "pill warn";
      doPull().then(function (algo) {
        if (algo === null) { st.textContent = "sem URL"; st.className = "pill"; return; }
        st.textContent = csvDiagText(); st.className = "pill ok";
        toast("Planilha carregada · " + algo.length + " processos");
        nav("dashboard");
      }).catch(function (e) {
        st.textContent = "Erro: " + (e && e.message ? e.message.slice(0, 60) : "falha"); st.className = "pill err";
        toast("Falha na planilha", "err-msg");
      });
    };
    $("btnPaste").onclick = function () {
      var incoming = parseCsv($("csvPaste").value);
      if (!incoming.length) return toast("CSV inválido", "err-msg");
      rows = incoming;
      scheduleSave();
      renderAll();
      toast(csvDiagText());
      nav("dashboard");
    };
    $("fileCsv").onchange = function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        var incoming = parseCsv(String(reader.result || ""));
        if (!incoming.length) return toast("Arquivo sem linhas válidas", "err-msg");
        rows = incoming;
        scheduleSave();
        renderAll();
        toast(csvDiagText());
        nav("dashboard");
      };
      reader.readAsText(f, "UTF-8");
    };
  }
  function bindScanner() {
    $("btnScanOne").onclick = function () {
      var out = $("scanOut");
      out.textContent = "Consultando…";
      runScan($("scanCnj").value).then(function (res) {
        out.textContent = vereditoHtml(res);
        var c = rows.find(function (x) { return onlyDigits(x.protocolo) === onlyDigits(res.cnj); });
        if (c) {
          var ch = applyScanToCase(c, res);
          c._scannedThisRun = true;
          feedPush(scanLogLine(c, res, ch, 0));
          appendScanLogRow({ cnj: c.protocolo, motor: "both", ok: true, detalhe: "consulta rápida" });
          scheduleSave();
          renderAll();
          toast(scanToast(ch));
        } else {
          toast(res.datajud && res.datajud.ok ? "Consulta realizada (CNJ fora da carteira)" : outputErrLabel(res), res.datajud && res.datajud.ok ? "" : "err-msg");
        }
      }).catch(function (e) {
        out.textContent = "Erro: " + (e && e.message ? e.message : e);
      });
    };
    function outputErrLabel(res) {
      if (res && res.datajud && res.datajud.error) return res.datajud.error;
      if (res && res.djen && res.djen.error) return res.djen.error;
      return "Sem retorno";
    }
    $("btnScanLocal").onclick = function () { startLocalScan(false); };
    $("btnScanPause").onclick = function () {
      if (SCAN.status === "running") {
        SCAN.status = "paused";
        writeScanProgress(SCAN.done, SCAN.total, SCAN.mode);
        feedSys("Pausado — use Retomar de onde parou", "ok");
        renderScanUI();
      } else if (SCAN.status === "paused") {
        SCAN.status = "running";
        renderScanUI();
        scanLoop();
      }
    };
    document.querySelectorAll('input[name="scMode"]').forEach(function (r) {
      r.addEventListener("change", function () {
        if (SCAN.status === "running") return;
        SCAN.mode = r.value;
        renderScanUI();
      });
    });
    $("scScopeFull").onclick = function () {
      if (SCAN.status === "running") return;
      SCAN.scope = "full"; renderScanUI();
    };
    $("scScopeCumpr").onclick = function () {
      if (SCAN.status === "running") return;
      SCAN.scope = "cumprimento"; renderScanUI();
    };
    document.querySelectorAll(".sc-tab").forEach(function (b) {
      b.addEventListener("click", function () { scanTab(b.getAttribute("data-sctab")); });
    });
    $("btnScLogExport").onclick = exportScanLogCsv;
    $("btnScLogClear").onclick = function () {
      if (!confirm("Limpar TODO o histórico de logs do scanner?")) return;
      clearScanLogRows();
      renderLogs();
      toast("Logs limpos");
    };
    $("btnVeredito").onclick = function () {
      var out = $("verOut");
      out.textContent = "…";
      runScan($("verCnj").value).then(function (res) {
        out.textContent = vereditoHtml(res);
        var c = rows.find(function (x) { return onlyDigits(x.protocolo) === onlyDigits(res.cnj); });
        if (c) { applyScanToCase(c, res); scheduleSave(); renderAll(); }
        toast("Veredito consultado");
      }).catch(function (e) {
        out.textContent = "Erro: " + (e && e.message ? e.message : e);
      });
    };
  }
  function bindDossie() {
    $("btnReport").onclick = function () {
      $("reportOut").innerHTML = buildDossier();
      toast("Dossiê gerado");
    };
    $("btnCopyReport").onclick = function () {
      var txt = $("reportOut").innerText || "";
      if (!txt) return toast("Gere o relatório primeiro");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () { toast("Copiado"); });
      } else { toast("Copie manualmente"); }
    };
    $("btnExportReport").onclick = function () {
      var html = $("reportOut").innerHTML || "";
      if (!html) return toast("Gere o relatório primeiro");
      if (window.lexisOffline && window.lexisOffline.exportPdf) {
        toast("Gerando PDF…");
        window.lexisOffline.exportPdf(html).then(function (r) {
          if (r && r.ok) toast("PDF salvo: " + r.path);
          else if (r && r.canceled) toast("Cancelado");
          else toast("Erro: " + (r && r.error || "desconhecido"), "err-msg");
        });
      } else {
        var w = window.open("", "_blank");
        w.document.write('<html><head><title>Dossiê</title><style>body{font-family:sans-serif;padding:20px;font-size:11px}table{width:100%;border-collapse:collapse;font-size:9px}th,td{padding:4px 8px;border-bottom:1px solid #ddd}th{background:#f5f5f5;font-weight:800;text-transform:uppercase;font-size:8px}@media print{body{padding:0}}</style></head><body>' + html + '</body></html>');
        w.document.close();
        setTimeout(function(){w.print();},500);
      }
    };
  }
  function bindNotas() {
    $("btnNota").onclick = function () {
      var ref = $("notaRef").value.trim();
      var text = $("notaTxt").value.trim();
      if (!text) return toast("Escreva a nota");
      notes.push({ ref: ref || "—", text: text, at: new Date().toLocaleString("pt-BR") });
      $("notaTxt").value = "";
      scheduleSave();
      renderNotas();
      toast("Nota salva");
    };
  }
  function bindConfig() {
    $("btnSaveCfg").onclick = function () {
      readCfgFromInputs(true);
      if (!cfg.token) cfg.token = "w1-fase1-2026";
      saveCfg();
      if ($("sheetsUrl")) $("sheetsUrl").value = cfg.url;
      toast("Configurações salvas");
    };
    $("btnTestWebhook").onclick = testWebhook;
  }
  function bindCadastro() {
    var btnSave = $("btnCadSave");
    if (btnSave) btnSave.onclick = function () {
      var cliente = ($("cadCliente") ? $("cadCliente").value : "").trim();
      if (!cliente) return toast("Informe o nome do cliente", "err-msg");
      var proto = ($("cadProtocolo") ? $("cadProtocolo").value : "").trim();
      var id = onlyDigits(proto) || "cad_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
      var c = {
        id: id,
        protocolo: proto,
        cliente: cliente,
        telefone: ($("cadTelefone") ? $("cadTelefone").value : "").trim(),
        tribunal: ($("cadTribunal") ? $("cadTribunal").value : "").trim(),
        advogado: ($("cadAdvogado") ? $("cadAdvogado").value : "").trim(),
        escritorio: ($("cadEscritorio") ? $("cadEscritorio").value : "").trim(),
        situacao: ($("cadSituacao") ? $("cadSituacao").value : "EM ANDAMENTO").trim() || "EM ANDAMENTO",
        observacao: ($("cadObs") ? $("cadObs").value : "").trim(),
        ultimoRetorno: ($("cadUltimo") ? $("cadUltimo").value : null) || null,
        proximoPrazo: ($("cadPrazo") ? $("cadPrazo").value : null) || null,
        statusManual: "Automatico",
        arquivado: false,
        origem: "cadastro"
      };
      rows.push(c);
      scheduleSave();
      renderAll();
      toast("Processo cadastrado: " + cliente);
      ["cadCliente","cadProtocolo","cadTelefone","cadTribunal","cadAdvogado","cadEscritorio","cadObs"].forEach(function(k){var e=$(k);if(e)e.value="";});
      if ($("cadSituacao")) $("cadSituacao").value = "EM ANDAMENTO";
      if ($("cadUltimo")) $("cadUltimo").value = "";
      if ($("cadPrazo")) $("cadPrazo").value = "";
      pushOne(c);
    };
    var btnClear = $("btnCadClear");
    if (btnClear) btnClear.onclick = function () {
      ["cadCliente","cadProtocolo","cadTelefone","cadTribunal","cadAdvogado","cadEscritorio","cadObs"].forEach(function(k){var e=$(k);if(e)e.value="";});
      if ($("cadSituacao")) $("cadSituacao").value = "EM ANDAMENTO";
      if ($("cadUltimo")) $("cadUltimo").value = "";
      if ($("cadPrazo")) $("cadPrazo").value = "";
    };
    var btnBatch = $("btnCadBatch");
    if (btnBatch) btnBatch.onclick = function () {
      var txt = ($("cadBatchCsv") ? $("cadBatchCsv").value : "").trim();
      if (!txt) return toast("Cole linhas CSV", "err-msg");
      var lines = txt.split("\n").map(function(l){return l.trim();}).filter(Boolean);
      var added = 0;
      lines.forEach(function(line) {
        var cells = line.split(",").map(function(c){return c.trim();});
        if (!cells[0]) return;
        var proto = cells[1] || "";
        var id = onlyDigits(proto) || "batch_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
        rows.push({
          id: id, protocolo: proto, cliente: cells[0], telefone: cells[2] || "",
          tribunal: "", advogado: "", escritorio: "",
          situacao: cells[3] || "EM ANDAMENTO", observacao: cells[4] || "",
          ultimoRetorno: null, proximoPrazo: null,
          statusManual: "Automatico", arquivado: false, origem: "batch"
        });
        added++;
      });
      if (added) { scheduleSave(); renderAll(); toast(added + " processos importados"); }
      else toast("Nenhuma linha válida", "err-msg");
    };
  }
  function bindRows() {
    document.body.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-act]");
      if (!btn) return;
      var act = btn.getAttribute("data-act");
      var id = btn.getAttribute("data-id");
      var c = findById(id);
      if (!c) return;
      if (act === "atend") openAtend(id);
      if (act === "edit") openEdit(id);
      if (act === "desfazer") {
        c.situacao = "EM ANDAMENTO";
        c.statusManual = "Automatico";
        c.datajud_encerrado_tribunal = false;
        scheduleSave();
        renderAll();
        toast("Reaberto");
        pushOne(c);
      }
      if (act === "wa") {
        var n = onlyDigits(c.telefone);
        if (n.length <= 11) n = "55" + n;
        var url = "https://wa.me/" + n;
        if (window.lexisOffline && window.lexisOffline.openExternal) window.lexisOffline.openExternal(url);
        else window.open(url);
      }
      if (act === "scan") {
        nav("scanner");
        $("scanCnj").value = c.protocolo || "";
      }
      if (act === "abrir" && c.protocolo) {
        var t = (c.tribunal || "").toLowerCase().replace(/[^a-z]/g, "");
        var host = "https://esaj.tjsp.jus.br/cpopg/search.do?conversationId=&cbNuProcesso=" + encodeURIComponent(c.protocolo) + "&numeroDigitoAnoUnificado=&foroNumeroUnificado=&dadosConsulta.valorConsultaNuUnificado=" + encodeURIComponent(c.protocolo);
        if (window.lexisOffline && window.lexisOffline.openExternal) window.lexisOffline.openExternal(host);
        else window.open(host);
      }
    });
  }
  function bindModal() {
    $("atendCancel").onclick = function () { $("modalAtend").classList.remove("show"); };
    $("atendSave").onclick = saveAtendimento;
    $("edCancel").onclick = function () { $("modalEdit").classList.remove("show"); };
    $("edSave").onclick = saveEdit;
    $("edDelete").onclick = deleteEdit;
    ["qFila", "qCasos", "filtroFila", "filtroCasos"].forEach(function (id) {
      var el = $(id);
      if (el) {
        el.addEventListener("input", function () {
          if (id === "qFila" || id === "filtroFila") renderFila();
          if (id === "qCasos" || id === "filtroCasos") renderCasos();
        });
        el.addEventListener("change", function () {
          if (id === "qFila" || id === "filtroFila") renderFila();
          if (id === "qCasos" || id === "filtroCasos") renderCasos();
        });
      }
    });
  }

  /* ============================ init ============================ */
  loadCfg();
  renderConfig();
  bindNav();
  bindCommon();
  bindImport();
  bindScanner();
  bindDossie();
  bindNotas();
  bindConfig();
  bindCadastro();
  bindRows();
  bindModal();

  try {
    if (document.documentElement.classList.contains("dark") === false) {
      var t = localStorage.getItem(LS.theme);
      if (t === "dark") document.documentElement.classList.add("dark");
    }
  } catch (e) {}

  if (!window.lexisOffline) {
    toast("Abra pelo Lexis Gabinete.exe (não no Chrome)");
  } else {
    window.lexisOffline.getPaths().then(function (p) {
      if ($("pathInfo")) $("pathInfo").textContent = "DB: " + ((p && p.db) || "—");
    }).catch(function () {});
  }
  loadFromDisk().then(function () {
    if ($("sheetsUrl") && cfg.url) $("sheetsUrl").value = cfg.url;
    if (cfg.url && window.lexisOffline) {
      setSyncPill("planilha vinculada", "");
      var manual = localStorage.getItem("lexis_g_auto") || "off";
      if (manual === "on") syncAll();
    }
    renderAll();
    if (window.lexisOffline) {
      window.__connWatch = setInterval(function () {
        var on = navigator.onLine;
        var p = $("connPill");
        if (p) {
          p.textContent = on ? "online" : "offline";
          p.className = "pill " + (on ? "ok" : "err");
        }
      }, 4000);
    }
  });
})();