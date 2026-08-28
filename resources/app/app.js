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

  var LS = { url: "lexis_g_sheets_url", web: "lexis_g_webhook", tok: "lexis_g_token", oper: "lexis_g_oper", theme: "lexis_g_theme", dbg: "lexis_sync_debug", sess: "lexis_g_session" };
  var cfg = { url: "", webhook: "", token: "", oper: "" };
  var sess = null;
  var localMode = false;
  var rowsAll = [];
  var lastSync = "";
  var syncLog = [];
  function logSync(step, info) {
    var t = new Date().toLocaleTimeString("pt-BR");
    syncLog.push({ t: t, step: step, info: info == null ? "" : String(info).slice(0, 300) });
    if (syncLog.length > 40) syncLog = syncLog.slice(-40);
    try { localStorage.setItem(LS.dbg, JSON.stringify(syncLog)); } catch (e) {}
  }
  function lastSyncLine() {
    if (!syncLog.length) return "Sem sincronização registrada nesta sessão.";
    var e = syncLog[syncLog.length - 1];
    return e.t + " · " + e.step + (e.info ? " — " + e.info : "");
  }

  var TITLES = {
    dashboard: ["Painel da carteira", "Visão geral"],
    fila: ["Fila de atendimento", "Tarefas críticas"],
    casos: ["Meus processos", "Carteira do gabinete"],
    processos: ["Processos da empresa", "Todas as carteiras"],
    parados: ["Processos parados", "Sem andamento há 60+ dias"],
    encerrados: ["Encerrados a revisar", "Filtro humano"],
    import: ["Importar", "Planilha · CSV · arquivo"],
    agenda: ["Agenda", "Semana · dia · lista"],
    dossie: ["Dossiê operacional", "Relatório da carteira"],
    veredito: ["Veredito", "Consulta DataJud + DJEN"],
    scanner: ["Scanner Omnipresente", "Varredura DataJud + DJEN · logs"],
    notas: ["Notas", "Anotações internas"],
    equipe: ["Equipe", "Usuários e permissões"],
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
  function kpisAll(list) {
    list = list || rows;
    var k = { total: list.length, ativos: 0, venc: 0, hoje: 0, aten: 0, seguro: 0, sem: 0, arq: 0, nov: 0, baixa: 0, improc: 0, proc: 0, atendidosHoje: 0 };
    list.forEach(function (c) {
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
        responsavel: pk(["responsavel", "usuario", "gestor", "donodoprocesso", "dono"]),
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
        advogado: /^advogado$/,
        responsavel: /^responsavel|^usuario|^gestor|^dono/,
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
      cfg.webhook = localStorage.getItem(LS.web) || "https://script.google.com/macros/s/AKfycbxro8UqTJUbFLSOFkpR3unyaBFX_FF-lOVc9_KBcJ8GP-fQmpTzAPRh7a1JLN4ECJMu/exec";
      cfg.token = localStorage.getItem(LS.tok) || "w1-fase1-2026";
      cfg.oper = localStorage.getItem(LS.oper) || "";
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
    set("responsavel", "Responsavel", c.responsavel);
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
    var payload = body || {};
    if (sess && sess.token && !payload.sess) payload = Object.assign({}, payload, { sess: sess.token });
    var wh = String(cfg.webhook).trim().replace(/\/dev(\b|$)/, "/exec");
    return window.lexisOffline.fetchJson(wh, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  }
  function api(act, extra) {
    var body = { token: cfg.token, action: act };
    for (var k in (extra || {})) body[k] = extra[k];
    return postRows(body);
  }
  function ownMatches(c) {
    if (!sess) return false;
    if (!c.responsavel) return false;
    var r = String(c.responsavel).trim().toLowerCase();
    var u = String(sess.usuario || "").toLowerCase();
    var n = String(sess.nome || "").toLowerCase();
    return r === u || r === n;
  }
  function visibleToMe(c) {
    if (!sess) return true;
    return ownMatches(c) || !String(c.responsavel || "").trim();
  }
  var ROLE_ACCESS = { assistente: 10, atendente: 10, responsavel: 10, supervisor: 20, superadmin: 30 };
  function roleLevel(p) {
    p = String(p || "assistente").trim().toLowerCase();
    if (ROLE_ACCESS[p] !== undefined) return ROLE_ACCESS[p];
    for (var k in ROLE_ACCESS) if (k.toLowerCase() === p) return ROLE_ACCESS[k];
    return 10;
  }
  function canAdmin() { return sess && roleLevel(sess.perfil) >= 20; }
  function saveSess() {
    try { localStorage.setItem(LS.sess, JSON.stringify(sess || {})); } catch (e) {}
  }
  function loadSess() {
    try {
      var raw = localStorage.getItem(LS.sess);
      if (raw) { var o = JSON.parse(raw); if (o && o.token) return { token: o.token, nome: o.nome || "", perfil: o.perfil || "", escritorio: o.escritorio || "", usuario: o.usuario || "" }; }
    } catch (e) {}
    return null;
  }
  function applySessionUI() {
    var chip = $("userChip"), lo = $("btnLogout"), ne = $("navEquipe");
    if (sess) {
      if (chip) chip.textContent = sess.nome + (sess.perfil ? " · " + sess.perfil : "");
      if (lo) lo.style.display = "";
      if (ne) ne.style.display = canAdmin() ? "" : "none";
      if (!canAdmin() && current === "equipe") nav("dashboard");
      setLoginOverlay(false);
    } else {
      if (chip) chip.textContent = "—";
      if (lo) lo.style.display = "none";
      if (ne) ne.style.display = "none";
    }
  }
  function setLoginOverlay(show) {
    var ov = $("loginOverlay");
    if (!ov) return;
    if (show) { ov.classList.remove("hidden"); } else { ov.classList.add("hidden"); }
  }
  function askLogin() {
    applySessionUI();
    setLoginOverlay(true);
    try { setTimeout(function () { if ($("loginEmail")) $("loginEmail").focus(); }, 60); } catch (e) {}
  }
  function doLogin(email, senha) {
    var msg = $("loginMsg");
    var btn = $("btnLogin");
    var btnText = $("btnLoginText");
    var btnLoader = $("btnLoginLoader");
    var btnArrow = $("btnLoginArrow");
    if (msg) { msg.className = "login-msg info"; msg.textContent = "Validando na planilha…"; }
    if (btn) { btn.disabled = true; if (btnText) btnText.textContent = "Sincronizando..."; if (btnLoader) btnLoader.style.display = "block"; if (btnArrow) btnArrow.style.display = "none"; }
    return api("auth", { usuario: email, senha: senha }).then(function (r) {
      if (r && r.ok && r.json && r.json.ok) {
        sess = { token: r.json.token, nome: r.json.user.nome, perfil: r.json.user.perfil, escritorio: r.json.user.escritorio, usuario: r.json.user.usuario };
        saveSess();
        logSync("login: ok", sess.usuario + " · " + sess.perfil);
        applySessionUI();
        if (msg) { msg.className = "login-msg ok"; msg.textContent = "Entrou como " + sess.nome + " (" + sess.perfil + ")"; }
        return { ok: true, sess: sess };
      }
      var err = (r && r.json && r.json.error) || "falha (veja o Config/Testar webhook)";
      logSync("login: recusado", err);
      if (msg) { msg.className = "login-msg err"; msg.textContent = "Acesso negado: " + err; }
      return { ok: false, error: err };
    }).catch(function (e) {
      if (msg) { msg.className = "login-msg err"; msg.textContent = "Sem conexão: " + (e && e.message ? e.message : "erro"); }
      return { ok: false, error: e && e.message ? e.message : "sem conexão" };
    }).finally(function () {
      if (btn) { btn.disabled = false; if (btnText) btnText.textContent = "Acessar Sistema"; if (btnLoader) btnLoader.style.display = "none"; if (btnArrow) btnArrow.style.display = ""; }
    });
  }
  function logout() {
    sess = null;
    try { localStorage.removeItem(LS.sess); } catch (e) {}
    rowsAll = [];
    applySessionUI();
    if (cfg.webhook) askLogin();
    toast("Sessão encerrada", "err-msg");
  }
  function toCsvRe(rowsArr) {
    function cell(s) {
      s = String(s == null ? "" : s);
      if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    }
    return rowsArr.map(function (r) { return r.map(cell).join(","); }).join("\r\n");
  }
  function buildFromArrays(headers, rowsArr) {
    var text = toCsvRe(rowsArr).replace(/^/, headers.map(function (h) { return String(h == null ? "" : h).replace(/"/g, '""'); }).join(",") + "\r\n");
    return parseCsv(text);
  }
  function pushOne(c) {
    if (!cfg.webhook) {
      queueOutbox(c);
      return false;
    }
    var row = sheetRow(c);
    postRows({ token: cfg.token, action: "write", rows: [row] }).then(function (r) {
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
    if (sess && sess.token && cfg.webhook) {
      logSync("pull: autenticado", sess.usuario);
      return api("list", {}).then(function (r) {
        logSync("pull: list", r && r.ok ? ("minhas=" + ((r.json && r.json.minhas && r.json.minhas.length) || 0) + " todas=" + ((r.json && r.json.todas && r.json.todas.length) || 0)) : "recusado: " + ((r && r.json && r.json.error) || (r && r.error) || "?"));
        if (!(r && r.ok && r.json && r.json.ok)) {
          throw new Error("auth: " + ((r && r.json && r.json.error) || "sessão inválida")); }
        var headers = r.json.headers || [];
        var minhas = buildFromArrays(headers, r.json.minhas || []);
        var todas = buildFromArrays(headers, r.json.todas || []);
        if (!minhas.length) logSync("pull: aviso", "nenhum caso devolvido para " + sess.usuario + " (verifique a coluna Responsavel)");
        rows = minhas;
        rowsAll = todas;
        outbox.forEach(function (o) { reaplicaPendencia(o); });
        scheduleSave(); renderAll(); setSyncPill("sync " + new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) + " · " + sess.usuario, "ok");
        return rows;
      });
    }
    logSync("pull: csv fallback", cfg.url.slice(0, 90));
    return window.lexisOffline.fetchText(cfg.url).then(function (res) {
      logSync("pull: resposta", (res && res.ok ? "ok " + String(res.text || "").length + "B" : "falha: " + ((res && res.error) || "?")));
      if (!res || !res.ok) throw new Error((res && res.error) || "falha na planilha");
      var incoming = parseCsv(res.text || "");
      logSync("pull: parse", "linhas " + incoming.length + (lastDiag ? " · RETORNO " + (lastDiag.retorno || "-") + " PRÓXIMO " + (lastDiag.proximo || "-") : ""));
      if (!incoming.length) throw new Error("nenhuma linha válida: " + csvDiagText());
      rows = incoming;
      rowsAll = incoming;
      if (sess) {
        rows = incoming.filter(visibleToMe);
        rowsAll = incoming.filter(visibleToMe);
        logSync("pull: filtro local", sess.usuario + " vê " + rows.length + "/" + incoming.length);
      }
      outbox.forEach(function (o) { reaplicaPendencia(o); });
      scheduleSave();
      renderAll();
      setSyncPill("sync " + new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }), "ok");
      return incoming;
    });
  }
  function reaplicaPendencia(o) {
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
          else if (low === normHeader(colMap.responsavel) || /responsavel|usuario|dono/.test(low)) rows[i].responsavel = v;
        }
      }
    }
  }
  function doPush() {
    if (!cfg.webhook) return Promise.resolve({ skipped: true });
    if (!outbox.length) return Promise.resolve({ skipped: true });
    var rowsPayload = outbox.map(function (o) { return o.row; });
    logSync("push: enviando", rowsPayload.length + " pendências");
    return postRows({ token: cfg.token, action: "write", rows: rowsPayload }).then(function (r) {
      logSync("push: resposta", (r && r.ok && r.json && r.json.ok) ? "ok updated=" + (r.json.updated) : "recusado: " + ((r && r.json && r.json.error) || (r && r.error) || (r && r.text ? String(r.text).slice(0, 120) : "?")));
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
    var t0 = Date.now();
    logSync("sync: inicio", "manual/auto");
    setSyncPill("sincronizando…", "warn");
    var watchdog = setTimeout(function () {
      var sec = Math.round((Date.now() - t0) / 1000);
      logSync("sync: TRAVOU", sec + "s sem resposta");
      setSyncPill("erro: travou (" + sec + "s)", "err");
      toast("Sync travou em " + sec + "s — rede ou Google lento", "err-msg");
    }, 75000);
    function done() {
      clearTimeout(watchdog);
      try {
        var raw = localStorage.getItem(LS.dbg);
        if (raw) { var arr = JSON.parse(raw); if (Array.isArray(arr) && arr.length) syncLog = arr; }
      } catch (e) {}
      if (current === "config") renderConfig();
    }
    Promise.resolve()
      .then(doPull)
      .then(doPush)
      .catch(function (e) {
        logSync("sync: erro", e && e.message ? e.message : "falha");
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
    st.textContent = "Testando…";
    if (!cfg.webhook) { st.className = "hint err-msg"; st.textContent = "Falta a URL do webhook."; return; }
    postRows({ token: cfg.token || "?", action: "ping" }).then(function (r) {
      if (r && r.ok && r.json && r.json.pong) {
        st.className = "hint ok-msg";
        st.textContent = "Webhook OK — a planilha está pronta para receber edições.";
        toast("Webhook conectado", "ok-msg");
      } else {
        st.className = "hint err-msg";
        var detail = (r && r.json && r.json.error) || (r && r.error) || "";
        if (detail) {
          st.textContent = "Webhook falhou: " + detail + (r && r.http ? " (HTTP " + r.http + ")" : "") + ". Confira o acesso 'Qualquer pessoa' e o token.";
        } else {
          st.textContent = "Webhook respondeu algo inesperado" + (r && r.http ? " (HTTP " + r.http + ")" : "") + ". Pode ser a aba/página de login do Google.";
        }
      }
    }).catch(function (e) {
      st.className = "hint err-msg";
      st.textContent = "Falha: " + (e && e.message ? e.message : "sem conexão");
    });
  }

  /* ============================ renderizadores ============================ */
  function kpiCard(l, v, cls, s) {
    return '<div class="kpi ' + (cls || "") + '"><div class="l">' + l + '</div><div class="v">' + v + '</div>' + (s ? '<div class="s">' + s + "</div>" : "") + "</div>";
  }
  function actionsHtml(c) {
    return '<div class="row-actions">' +
      '<button type="button" class="btn btn-sm" data-act="atend" data-id="' + esc(c.id) + '">Atender</button>' +
      '<button type="button" class="btn btn-sm" data-act="edit" data-id="' + esc(c.id) + '">Editar</button>' +
      '<button type="button" class="btn btn-sm" data-act="sugerir" data-id="' + esc(c.id) + '" title="Revisar evento e ajustar">Sugerir</button>' +
      '<button type="button" class="btn btn-sm" data-act="scan" data-id="' + esc(c.id) + '" title="Consultar DataJud+DJEN">Scan</button>' +
      (c.telefone ? '<button type="button" class="btn btn-sm" data-act="wa" data-id="' + esc(c.id) + '">WhatsApp</button>' : "") +
      (c.protocolo ? '<button type="button" class="btn btn-sm" data-act="abrir" data-id="' + esc(c.id) + '" title="Abrir consulta no tribunal">CNJ</button>' : "") +
      "</div>";
  }
  function caseBadgesHtml(c) {
    var b = [];
    if (!onlyDigits(c.telefone)) b.push('<span class="badge b-sem" title="Sem telefone">sem tel</span>');
    if (c.is_procedente) b.push('<span class="badge b-ok">Procedente</span>');
    if (c.is_improcedente) b.push('<span class="badge b-ven">Improcedente</span>');
    if (c.datajud_encerrado_tribunal) b.push('<span class="badge b-hoje">Baixa</span>');
    if (c.tem_novo_andamento || c.djen_nova_comunicacao) b.push('<span class="badge b-crit">Novo</span>');
    return b.length ? '<div class="mini" style="margin-top:.2rem">' + b.join(" ") + "</div>" : "";
  }
  function rowHtml(c, extraCols) {
    var st = statusDe(c);
    var f = faixaPrioridade(pesoFila(c));
    var dias = diasAte(c.proximoPrazo);
    var h = "<tr" + (st === "Vencido" || st === "Caso Crítico" ? ' style="background:rgba(239,68,68,.05)"' : "") + "><td><b>" + esc(c.cliente || "—") + '</b><div class="mini">' + esc(c.protocolo || "") + "</div>" + caseBadgesHtml(c) + "</td>";
    h += "<td>" + badge(st) + '</td><td><span class="num">' + esc(c.proximoPrazo || "—") + "</span></td>";
    h += "<td>" + (dias === null ? "—" : '<span class="num" style="color:' + (dias < 0 ? "var(--vencido)" : dias === 0 ? "var(--hoje)" : "var(--muted)") + '">' + dias + "</span>") + "</td>";
    h += '<td><span class="badge ' + f[1] + '">' + f[0] + "</span></td>";
    if (extraCols) h += extraCols;
    h += "<td>" + actionsHtml(c) + "</td></tr>";
    return h;
  }
  function tableHtml(list, cols, extra) {
    if (!list.length) return '<div class="empty"><b>Nada aqui</b>Importe a planilha em Importar ou ajuste o filtro.</div>';
    var h = "<table><thead><tr>";
    (cols || ["Cliente", "Status", "Retorno", "Dias", "Prioridade"]).forEach(function (c) { h += "<th>" + c + "</th>"; });
    if (extra) h += "<th>" + extra + "</th>";
    h += "<th>Ações</th></tr></thead><tbody>";
    list.forEach(function (r) { h += rowHtml(r, extra); });
    h += "</tbody></table>";
    return h;
  }

  function casoEvento(c) {
    var ev = (c.evento_resumo || "").trim();
    if (ev) return ev;
    return (c.datajud_ultimo_movimento || "").trim() || "—";
  }
  function eventTableHtml(list) {
    if (!list.length) return '<div class="empty">Nada para listar.</div>';
    var h = "<table><thead><tr><th>Cliente</th><th>Status</th><th>Retorno</th><th>Dias</th><th>Prioridade</th><th>Evento</th><th>Ações</th></tr></thead><tbody>";
    list.forEach(function (c) {
      h += rowHtml(c, '<td class="mini" style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(casoEvento(c)) + "</td>");
    });
    h += "</tbody></table>";
    return h;
  }
  function tfMetaV() {
    try { var m = parseInt(localStorage.getItem("lexis_tf_meta") || "10", 10); return isNaN(m) || m < 1 ? 10 : m; } catch (e) { return 10; }
  }
  function tfMetaSet(v) {
    try { localStorage.setItem("lexis_tf_meta", String(v)); } catch (e) {}
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
      kpiCard("Baixas tribunal", k.baixa, k.baixa ? "hoje" : "") +
      kpiCard("Atendidos hoje", k.atendidosHoje, k.atendidosHoje ? "ok" : "") +
      kpiCard("Novidades", k.nov, k.nov ? "rose" : "") +
      kpiCard("Risco", risk.score + "%", risk.score > 59 ? "err" : risk.score > 39 ? "warn" : "ok", risk.label);

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
    var hoje = hojeBR();
    var venc = rows.filter(function (c) { var st = statusDe(c); return st === "Vencido" || st === "Caso Crítico"; }).length;
    var feitos = rows.filter(function (c) { return c.ultimoRetorno === hoje; }).length;
    var meta = tfMetaV();
    var pct = meta > 0 ? Math.min(100, Math.round((feitos / meta) * 100)) : 0;
    $("filaKpis").innerHTML =
      kpiCard("Pendentes", venc + k.hoje, (venc + k.hoje) ? (venc ? "err" : "hoje") : "ok", "vencidos + é hoje") +
      kpiCard("Atenção", k.aten, k.aten ? "warn" : "") +
      kpiCard("Novidades", k.nov, k.nov ? "rose" : "") +
      kpiCard("Finalizados hoje", feitos, feitos ? "ok" : "") +
      kpiCard("Meta do dia", feitos + "/" + meta, pct >= 100 ? "ok" : pct >= 60 ? "warn" : "pri", pct + "%");
    var minfo = $("tfMetaInfo");
    if (minfo) minfo.textContent = "Meta do dia · " + meta + " · faltam " + Math.max(0, meta - feitos);

    var meusHojeEl = $("tfMeusHoje"), soloMetaEl = $("tfSoloMeta");

    var q = (($("qFila") && $("qFila").value) || "").toLowerCase();
    var ff = ($("tfFiltro") && $("tfFiltro").value) || "todos";
    var pf = ($("tfPrazo") && $("tfPrazo").value) || "score";
    var meusHoje = !!(meusHojeEl && meusHojeEl.checked);
    var solo = !!(soloMetaEl && soloMetaEl.checked);
    var list = rows.filter(function (c) {
      var st = statusDe(c);
      if (st === "Arquivado") return false;
      var ev = (c.evento_resumo || "").toLowerCase();
      var base = c.ultimoRetorno || c.data_distribuicao;
      var ds = diasDesde(base);
      var dp = diasAte(c.proximoPrazo);
      if (ff === "novidade" && !(c.tem_novo_andamento || c.djen_nova_comunicacao)) return false;
      if (ff === "vencido" && st !== "Vencido" && st !== "Caso Crítico") return false;
      if (ff === "hoje" && st !== "É Hoje") return false;
      if (ff === "ba" && ev.indexOf("busca") < 0) return false;
      if (ff === "parados" && (c.datajud_ultimo_movimento || ds === null || ds < 60)) return false;
      if (ff === "sil45" && (ds === null || ds < 45)) return false;
      if (ff === "cumpr" && !/cumpriment|execuç|execucao/.test(ev)) return false;
      if (ff === "tranquilos" && !(st === "No Prazo" && (dp === null || dp > 60) && !c.tem_novo_andamento && !c.djen_nova_comunicacao)) return false;
      if (meusHoje && (dp === null || dp < 0 || dp > 1)) return false;
      if (q && String(c.cliente + " " + c.protocolo + " " + c.telefone).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    function cmpT(a, b) {
      if (pf === "az") return String(a.cliente || "").localeCompare(String(b.cliente || ""), "pt-BR");
      if (pf === "vencid") {
        var av = diasAte(a.proximoPrazo), bv = diasAte(b.proximoPrazo);
        return (av === null ? 99999 : av) - (bv === null ? 99999 : bv);
      }
      if (pf === "prazo") {
        var ap = a.proximoPrazo || "9999-99-99", bp = b.proximoPrazo || "9999-99-99";
        return ap < bp ? -1 : ap > bp ? 1 : 0;
      }
      return pesoFila(b) - pesoFila(a);
    }
    list = list.slice().sort(cmpT);
    if (solo) list = list.slice(0, meta);
    var groups = [], gmap = {};
    list.forEach(function (c) {
      var nm = c.cliente || "Sem cliente";
      if (!gmap[nm]) { gmap[nm] = []; groups.push([nm, gmap[nm]]); }
      gmap[nm].push(c);
    });
    var h = "";
    groups.forEach(function (g) {
      var arr = g[1];
      var score = arr.reduce(function (s, c) { return s + pesoFila(c); }, 0);
      var hasNov = arr.some(function (c) { return c.tem_novo_andamento || c.djen_nova_comunicacao; });
      h += '<div class="card task-group" style="margin-top:.6rem">';
      h += '<div class="toolbar" style="gap:.5rem;flex-wrap:wrap">';
      h += '<h2 style="margin:0;flex:1;min-width:150px">' + esc(g[0]) + "</h2>";
      if (hasNov) h += '<span class="pill rose">novidade</span>';
      h += '<span class="pill">' + arr.length + " caso" + (arr.length > 1 ? "s" : "") + "</span>";
      h += '<span class="badge ' + faixaPrioridade(score)[1] + '">score ' + score + "</span>";
      h += "</div>";
      h += eventTableHtml(arr);
      h += "</div>";
    });
    if (!h) h = '<div class="empty"><b>Fila vazia</b>Ajuste os filtros ou importe a planilha.</div>';
    $("filaCards").innerHTML = h;
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
    var all = rowsAll.length ? rowsAll : rows;
    var k = kpisAll(all);
    var atendSemana = [];
    all.forEach(function (c) {
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
    $("empTable").innerHTML = tableHtml(sortByPriority(all).slice(0, 500), ["Cliente", "Status", "Retorno", "Dias", "Prioridade"]);
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
  function renderDossie() {
    var period = ($("repPeriod") && $("repPeriod").value) || "semana";
    var today = hojeBR();
    var k = kpisAll();
    var risk = computeRisk(k);
    function inPeriod(iso) {
      var d = diasDesde(iso);
      if (d === null || d < 0) return false;
      if (period === "semana") return d <= 7;
      if (period === "anterior") return d >= 8 && d <= 14;
      if (period === "mes") return String(iso || "").slice(0, 7) === today.slice(0, 7);
      return true;
    }
    var eventos = rows.filter(function (c) { return c.ultimoRetorno && inPeriod(c.ultimoRetorno); });
    var atendidos = rows.filter(function (c) { return c.ultimoRetorno && inPeriod(c.ultimoRetorno); }).length;
    var filaAtual = rows.filter(function (c) { var st = statusDe(c); return st === "Vencido" || st === "É Hoje"; });
    var criticidade = sortByPriority(rows.filter(function (c) { return statusDe(c) !== "Arquivado"; })).slice(0, 10);
    var parados60 = rows.filter(function (c) {
      if (statusDe(c) === "Arquivado") return false;
      if (c.datajud_ultimo_movimento) return false;
      var ds = diasDesde(c.ultimoRetorno || c.data_distribuicao);
      return ds === null || ds >= 60;
    });
    var topEncerra = sortByPriority(rows.filter(function (c) {
      if (statusDe(c) === "Arquivado") return false;
      return isBaixaTribunal(c) || hasStrongEncerrado(c) || c.is_procedente || /cumpriment/.test((c.evento_resumo || "").toLowerCase());
    })).slice(0, 10);
    var salvos = rows.filter(function (c) { return c.is_procedente; });
    var sentenc = rows.filter(function (c) {
      var ev = (c.evento_resumo || "").toLowerCase();
      return /senten[çc]|julgad/.test(ev) || c.is_improcedente;
    });
    $("repKpis").innerHTML =
      kpiCard("Carteira", k.total, "") +
      kpiCard("Ativos", k.ativos, "pri") +
      kpiCard("Vencidos", k.venc, k.venc ? "err" : "") +
      kpiCard("É hoje", k.hoje, k.hoje ? "hoje" : "") +
      kpiCard("Atenção", k.aten, k.aten ? "warn" : "") +
      kpiCard("Sem prazo", k.sem, "pri") +
      kpiCard("Arquivados", k.arq, "") +
      kpiCard("Baixas tribunal", k.baixa, k.baixa ? "hoje" : "") +
      kpiCard("Novidades", k.nov, k.nov ? "rose" : "") +
      kpiCard("Risco", risk.score + "%", risk.score > 59 ? "err" : risk.score > 39 ? "warn" : "ok", risk.label) +
      kpiCard("Procedentes", k.proc, k.proc ? "ok" : "") +
      kpiCard("Improcedentes", k.improc, k.improc ? "warn" : "") +
      kpiCard("Atendimentos", atendidos, atendidos ? "ok" : "") +
      kpiCard("Meta do dia", tfMetaV(), "") +
      kpiCard("Fila (v+h)", filaAtual.length, filaAtual.length ? "err" : "ok") +
      kpiCard("Parados 60+", parados60.length, parados60.length ? "warn" : "ok");
    var dias = {};
    eventos.forEach(function (c) { dias[c.ultimoRetorno] = (dias[c.ultimoRetorno] || 0) + 1; });
    var keys = Object.keys(dias).sort();
    $("repDias").innerHTML = keys.length
      ? '<div style="display:flex;gap:.5rem;flex-wrap:wrap">' + keys.map(function (d2) { return '<span class="pill">' + fmtBR(d2) + " · " + dias[d2] + "</span>"; }).join("") + "</div>"
      : '<div class="empty">Sem atendimentos no período.</div>';
    $("repCrit").innerHTML = eventTableHtml(criticidade);
    $("repEncerra").innerHTML = eventTableHtml(topEncerra);
    $("repParados").innerHTML = eventTableHtml(parados60.slice(0, 20));
    function merRow(lbl, n, note) {
      return "<tr><td><b>" + esc(lbl) + '</b></td><td><span class="num">' + n + '</span></td><td class="mini">' + note + "</td></tr>";
    }
    $("repMerito").innerHTML =
      "<table><thead><tr><th>Mérito</th><th>Casos</th><th>Base</th></tr></thead><tbody>" +
      merRow("Procedentes (salvos)", k.proc, "Faixa ou evento com procedência") +
      merRow("Improcedentes", k.improc, "Faixa de improcedência") +
      merRow("Sentenciados / julgados", sentenc.length, "Evento contém sentença/julgamento") +
      merRow("Baixas do tribunal", k.baixa, "Tribunal deu baixa definitiva") +
      "</tbody></table>";
  }

  var agAnchor = new Date();
    agAnchor.setHours(12, 0, 0, 0);
    var agView = "semana";
    function isoOf(d) {
      var z = function (n) { return (n < 10 ? "0" : "") + n; };
      return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate());
    }
    function fmtBR(iso) {
      if (!iso) return "";
      var p = String(iso).split("-");
      return (p[2] || "") + "/" + (p[1] || "");
    }
    function agMonday() {
      var d = new Date(agAnchor.getTime());
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      return d;
    }
    function agDayHtml(iso, label, isToday) {
      var today = hojeBR();
      var d = diasAte(iso);
      var cls = isToday ? "ag-today" : (d !== null && d < 0 ? "ag-past" : "");
      var cap = "vencido " + Math.abs(d) + "d";
      var sub = d === null ? "" : d === 0 ? "hoje" : "em " + d + "d";
      var evs = rows.filter(function (c) {
        if (statusDe(c) === "Arquivado") return false;
        var st = statusDe(c); if (st === "Vencido" || st === "Caso Crítico") return false;
        return c.proximoPrazo === iso;
      });
      var h = '<div class="ag-day ' + cls + '"><div class="ag-head"><b>' + esc(label) + "</b><small>" + (d !== null && d < 0 ? cap : sub) + "</small></div><div class='ag-body'>";
      if (!evs.length) h += '<div class="mini" style="padding:.4rem">—</div>';
      evs.forEach(function (c) {
        h += '<div class="ag-item"><div style="font-weight:700;font-size:.82rem">' + esc(c.cliente || "—") + '</div><div class="mini">' + esc(casoEvento(c)) + '</div><div class="row-actions"><button type="button" class="btn btn-sm" data-act="atend" data-id="' + esc(c.id) + '">Atender</button></div></div>';
      });
      h += "</div></div>";
      return h;
    }
    function renderAgenda() {
      var k = kpisAll();
      var today = hojeBR();
      var dp = rows.filter(function (c) { return statusDe(c) !== "Arquivado" && c.proximoPrazo; });
      $("agKpis").innerHTML =
        kpiCard("Vencidos", k.venc, k.venc ? "err" : "") +
        kpiCard("É hoje", k.hoje, k.hoje ? "hoje" : "") +
        kpiCard("Atenção", k.aten, k.aten ? "warn" : "") +
        kpiCard("Com prazo marcado", dp.length, "pri");
      var view = agView;
      $("agWeek").style.display = view === "semana" ? "" : "none";
      $("agDay").style.display = view === "dia" ? "" : "none";
      $("agList").style.display = view === "lista" ? "" : "none";
      document.querySelectorAll(".ag-v").forEach(function (b) {
        b.classList.toggle("active", b.getAttribute("data-agv") === view);
      });
      var lbl = $("agWeekLabel");
      if (view === "semana") {
        var mon = agMonday();
        lbl.textContent = "Semana de " + fmtBR(isoOf(mon)) + " a " + fmtBR(isoOf(new Date(mon.getTime() + 6 * 86400000)));
        var w = '<div class="ag-grid">';
        var names = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
        for (var i = 0; i < 7; i++) {
          var day = new Date(mon.getTime() + i * 86400000);
          w += agDayHtml(isoOf(day), names[i] + " " + day.getDate(), isoOf(day) === today);
        }
        $("agWeek").innerHTML = w + "</div>";
      } else if (view === "dia") {
        lbl.textContent = "Dia " + fmtBR(isoOf(agAnchor)) + (isoOf(agAnchor) === today ? " · hoje" : "");
        $("agDay").innerHTML = '<div class="ag-grid">' + agDayHtml(isoOf(agAnchor), fmtBR(isoOf(agAnchor)) + " · " + "clique em Atender para remarcar", isoOf(agAnchor) === today) + "</div>";
      } else {
        lbl.textContent = "Lista · prioridade";
        var ll = sortByPriority(rows.filter(function (c) {
          if (statusDe(c) === "Arquivado") return false;
          var st = statusDe(c); if (st === "Vencido" || st === "Caso Crítico") return true;
          var d = diasAte(c.proximoPrazo); return c.proximoPrazo && d !== null && d <= 30;
        }));
        $("agList").innerHTML = eventTableHtml(ll.slice(0, 200));
      }
      var ot = $("agWeek").getElementsByClassName("ag-today");
      if (ot.length && view === "semana") ot[0].scrollIntoView({ block: "nearest", inline: "nearest" });
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
    var ls = $("cfgLastSync");
    if (ls) ls.textContent = "Última atividade de sync: " + lastSyncLine();
  }

  /* ============================ equipe (supervisor/superadmin) ============================ */
  function loadEquipe() {
    var box = $("eqTable"), st = $("eqStatus");
    if (!canAdmin()) { if (box) box.innerHTML = ""; return; }
    if (st) st.textContent = "Carregando usuários…";
    api("users", {}).then(function (r) {
      if (!r || !r.ok || !r.json || !r.json.ok) {
        var err = (r && r.json && r.json.error) || "sem resposta";
        if (st) st.textContent = "Falha: " + err;
        if (box) box.innerHTML = '<div class="empty">' + esc(err) + "</div>";
        return;
      }
      if (st) st.textContent = r.json.users.length + " usuário(s) · via planilha";
      if (!box) return;
      var L = roleLevel(sess.perfil);
      box.innerHTML = "<table><thead><tr><th>Login</th><th>Nome</th><th>Perfil</th><th>Ati.</th><th>Ações</th></tr></thead><tbody>" +
        r.json.users.map(function (u) {
          var me = sess && sess.usuario === u.login;
          var lock = roleLevel(u.perfil) > L;
          var canTouch = !me && !lock;
          var ban = String(u.ativo) === "sim" ? "Banir" : "Ativar";
          var cls = String(u.ativo) === "sim" ? "ok-msg" : "err-badge";
          return "<tr><td><b>" + esc(u.login) + "</b>" + (me ? ' <span class="mini">(você)</span>' : "") + "</td>" +
            "<td>" + esc(u.nome) + "</td>" +
            "<td>" + esc(u.perfil) + "</td>" +
            "<td><span class='" + cls + "'>" + (String(u.ativo) === "sim" ? "ativo" : "banido") + "</span></td>" +
            "<td>" + (canTouch
              ? "<button class='mini-btn' data-eqban='" + esc(u.login) + "'>" + ban + "</button>"
              : "<span class='mini'>" + (lock ? "acima de você" : "") + (me ? "você mesmo" : "") + "</span>") + "</td></tr>";
        }).join("") + "</tbody></table>";
      box.querySelectorAll("[data-eqban]").forEach(function (b) {
        b.addEventListener("click", function () {
          var login = b.getAttribute("data-eqban");
          var acao = b.textContent.trim() === "Ativar" ? "sim" : "nao";
          if (acao === "nao" && !confirm("Banir " + login + "? Ele não vai mais conseguir entrar.")) return;
          api("user_set", { login: login, ativo: acao }).then(function (r) {
            if (r && r.ok && r.json && r.json.ok) { toast("Atualizado: " + login); loadEquipe(); }
            else toast((r && r.json && r.json.error) || "falha ao atualizar", "err-badge");
          });
        });
      });
    });
  }
  function novoUsuario() {
    var login = String($("eqLogin").value || "").trim().toLowerCase();
    var nome = String($("eqNome").value || "").trim();
    var senha = String($("eqSenha").value || "");
    var perfil = String($("eqPerfil").value || "assistente");
    var escr = String($("eqEscritorio").value || "").trim();
    if (!login || senha.length < 4) { toast("Login e senha (4+ caracteres) são obrigatórios", "err-badge"); return; }
    api("user_create", { login: login, nome: nome || login, senha: senha, perfil: perfil, escritorio: escr }).then(function (r) {
      if (r && r.ok && r.json && r.json.ok) {
        toast("Usuário criado: " + login);
        $("eqLogin").value = ""; $("eqNome").value = ""; $("eqSenha").value = ""; $("eqEscritorio").value = "";
        loadEquipe();
      } else toast((r && r.json && r.json.error) || "falha ao criar", "err-badge");
    });
  }
  function renderAll() {
    renderDashboard();
    renderFila();
    renderCasos();
    renderProcessos();
    renderParados();
    renderEncerrados();
    renderDossie();
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
    if (name === "equipe") loadEquipe();
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
    $("edResponsavel").value = c.responsavel || "";
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
    c.responsavel = $("edResponsavel").value.trim() || c.responsavel;
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
    var k = kpisAll();
    var risk = computeRisk(k);
    var hoje = hojeBR();
    var t = "";
    t += "═══════════════════════════════════════════\n";
    t += "   DOSSIÊ OPERACIONAL · LEXIS GABINETE v6.0\n";
    t += "   " + hoje + "\n";
    t += "═══════════════════════════════════════════\n\n";
    t += "RESUMO\n";
    t += "  Carteira: " + k.total + " | Ativos: " + k.ativos + "\n";
    t += "  Vencidos: " + k.venc + " | É hoje: " + k.hoje + " | Atenção: " + k.aten + "\n";
    t += "  Sem prazo: " + k.sem + " | Arquivados: " + k.arq + "\n";
    t += "  Atendidos hoje: " + k.atendidosHoje + " | Novidades: " + k.nov + "\n";
    t += "  Baixas tribunal: " + k.baixa + " | Procedentes: " + k.proc + " | Improcedentes: " + k.improc + "\n";
    t += "  Risco global: " + risk.score + "/100 (" + risk.label + ")\n\n";
    t += "VENCIDOS + É HOJE (fila crítica · " + (k.venc + k.hoje) + ")\n";
    var crit = sortByPriority(rows.filter(function (c) {
      var st = statusDe(c); return st === "Vencido" || st === "É Hoje" || st === "Caso Crítico";
    }));
    crit.slice(0, 40).forEach(function (c, i) {
      var f = faixaPrioridade(pesoFila(c));
      t += "  " + (i + 1) + ". [" + f[0].toUpperCase() + "] " + (c.cliente || "—") + " | " + (c.protocolo || "—") + " | prazo " + (c.proximoPrazo || "—") + "\n";
    });
    t += "\nPARADOS ≥ 60 DIAS\n";
    var par = rows.filter(function (c) {
      var st = statusDe(c); if (st === "Arquivado") return false;
      var d = diasDesde(c.ultimoRetorno || c.data_distribuicao);
      return d === null || d >= 60;
    });
    par.slice(0, 20).forEach(function (c) {
      t += "  • " + (c.cliente || "—") + " | " + (c.protocolo || "—") + "\n";
    });
    t += "\n— Gerado localmente · W1 Capital —\n";
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
  function buildReportPdf() {
    var today = hojeBR();
    var k = kpisAll();
    var risk = computeRisk(k);
    var U = sess ? (sess.nome || sess.usuario) : "local";
    function trA(arr, cols) {
      var h = "<table><thead><tr>";
      cols.forEach(function (c) { h += "<th>" + c + "</th>"; });
      h += "</tr></thead><tbody>";
      arr.forEach(function (c) {
        var st = statusDe(c);
        var d = diasAte(c.proximoPrazo);
        h += "<tr><td><b>" + esc(c.cliente || "—") + "</b><br><small>" + esc(c.protocolo || "") + "</small></td>";
        h += "<td>" + st + "</td><td>" + esc(c.proximoPrazo || "—") + "</td><td>" + (d === null ? "—" : d) + "</td>";
        h += "<td>" + esc(casoEvento(c)) + "</td></tr>";
      });
      return h + "</tbody></table>";
    }
    function block(title, body) {
      return "<div class='blk'><h3>" + title + "</h3>" + body + "</div>";
    }
    var kpis = "";
    var cards = [
      ["Carteira", k.total], ["Ativos", k.ativos], ["Vencidos", k.venc], ["É hoje", k.hoje],
      ["Atenção", k.aten], ["Sem prazo", k.sem], ["Arquivados", k.arq], ["Baixas tribunal", k.baixa],
      ["Novidades", k.nov], ["Risco", risk.score + "%"], ["Procedentes", k.proc], ["Improcedentes", k.improc]
    ];
    cards.forEach(function (x) { kpis += '<span class="k"><b>' + x[0] + "</b>" + x[1] + "</span>"; });
    var eventos = rows.filter(function (c) { return c.ultimoRetorno; });
    var dias = {};
    eventos.forEach(function (c) { dias[c.ultimoRetorno] = (dias[c.ultimoRetorno] || 0) + 1; });
    var keysDias = Object.keys(dias).sort();
    var criticidade = sortByPriority(rows.filter(function (c) { return statusDe(c) !== "Arquivado"; })).slice(0, 10);
    var parados = rows.filter(function (c) {
      if (statusDe(c) === "Arquivado" || c.datajud_ultimo_movimento) return false;
      var ds = diasDesde(c.ultimoRetorno || c.data_distribuicao);
      return !ds || ds >= 60;
    }).slice(0, 20);
    var filaAtual = rows.filter(function (c) { var st = statusDe(c); return st === "Vencido" || st === "É Hoje"; });
    var html = "<!DOCTYPE html><html lang='pt-BR'><head><meta charset='utf-8'><title>Dossiê operacional</title><style>" +
      "body{font:12px/1.4 'Segoe UI',Arial,sans-serif;color:#1e293b;margin:26px}h1{font-size:20px;margin:0 0 2px}" +
      "h3{margin:.3rem 0}small{color:#64748b;font-weight:400}.meta{color:#475569;margin-bottom:12px}" +
      ".kpis{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.k{flex:1 1 90px;border:1px solid #e2e8f0;border-radius:8px;padding:8px;text-align:center}" +
      ".k b{display:block;font-size:10px;text-transform:uppercase;color:#475569}" +
      ".k{font-size:18px;font-weight:700}.blk{margin:16px 0;page-break-inside:avoid}" +
      "table{width:100%;border-collapse:collapse;margin-top:6px}th{background:#f1f5f9;text-align:left;padding:5px 6px;font-size:10px;text-transform:uppercase}" +
      "td{padding:5px 6px;border-bottom:1px solid #e2e8f0}.pill{display:inline-block;padding:2px 8px;border:1px solid #cbd5e1;border-radius:99px;margin:2px;font-size:11px}" +
      "</style></head><body>" +
      "<h1>Dossiê operacional — Lexis Gabinete</h1>" +
      "<div class='meta'>Usuário: " + esc(U) + " &nbsp;·&nbsp; " + today.replace(/-/g, "/").split("/").reverse().join("/") + " &nbsp;·&nbsp; " + rows.length + " casos na visão</div>" +
      "<div class='kpis'>" + kpis + "</div>" +
      block("Fila atual (vencidos + é hoje) · " + filaAtual.length, filaAtual.length ? trA(sortByPriority(filaAtual).slice(0, 30), ["Cliente", "Status", "Retorno", "Dias", "Evento"]) : "<small>Nenhuma pendência crítica.</small>") +
      block("Atendimentos por dia", keysDias.length ? keysDias.map(function (d2) { return "<span class='pill'>" + d2.replace(/-/g, "/").split("/").reverse().join("/") + " · " + dias[d2] + "</span>"; }).join("") : "<small>Sem atendimentos ainda.</small>") +
      block("Top criticidade · 10", trA(criticidade, ["Cliente", "Status", "Retorno", "Dias", "Evento"])) +
      block("Encerramento (revisar)", trA(sortByPriority(rows.filter(function (c) {
        if (statusDe(c) === "Arquivado") return false;
        return isBaixaTribunal(c) || hasStrongEncerrado(c) || c.is_procedente;
      })).slice(0, 10), ["Cliente", "Status", "Retorno", "Dias", "Evento"])) +
      block("Parados 60+ dias", parados.length ? trA(parados, ["Cliente", "Status", "Retorno", "Dias", "Evento"]) : "<small>Nenhum parado.</small>") +
      block("Mérito", "<b>Procedentes:</b> " + k.proc + " &nbsp;&nbsp; <b>Improcedentes:</b> " + k.improc + " &nbsp;&nbsp; <b>Baixas:</b> " + k.baixa) +
      "</body></html>";
    return html;
  }
  function bindDossie() {
    $("btnReport").onclick = function () {
      $("reportOut").textContent = buildDossier();
      toast("Dossiê gerado");
    };
    $("btnReportPdf").onclick = function () {
      var html = buildReportPdf();
      if (!window.lexisOffline || !window.lexisOffline.printPdf) { toast("PDF requer o Lexis Gabinete.exe", "err-msg"); return; }
      window.lexisOffline.printPdf({ html: html, name: "dossie-operacional.pdf" }).then(function (r) {
        if (!r) return toast("Falha ao gerar PDF", "err-msg");
        if (r.ok) toast("PDF salvo: " + (r.path || ""), "ok-msg");
        else if (!r.canceled) toast("Erro PDF: " + (r.error || "?"), "err-msg");
      });
    };
    $("btnCopyReport").onclick = function () {
      var txt = $("reportOut").textContent || "";
      if (!txt) return toast("Gere o relatório primeiro");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () { toast("Copiado"); });
      } else { toast("Copie manualmente"); }
    };
    $("btnExportReport").onclick = function () {
      var txt = $("reportOut").textContent || "";
      if (!txt) return toast("Gere o relatório primeiro");
      if (window.lexisOffline && window.lexisOffline.exportCsvFile) {
        window.lexisOffline.exportCsvFile(txt, "dossie-operacional.txt").then(function () { toast("Arquivo salvo"); });
      } else {
        var a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([txt], { type: "text/plain" }));
        a.download = "dossie-operacional.txt"; a.click();
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
      cfg.url = $("cfgUrl").value.trim();
      cfg.webhook = $("cfgWebhook").value.trim();
      cfg.token = $("cfgToken").value.trim();
      cfg.oper = $("cfgOper").value.trim();
      saveCfg();
      if ($("sheetsUrl")) $("sheetsUrl").value = cfg.url;
      toast("Configurações salvas");
    };
    $("btnTestWebhook").onclick = testWebhook;
  }
  var REG_TOKEN = "Azadsd5a96d5.6as5sa2d652as+94s9";
  var remoteAccessEnabled = false;
  function bindLogin() {
    var form = $("loginForm");
    var emailEl = $("loginEmail");
    var passEl = $("loginPass");
    var tokenEl = $("loginToken");
    var tokenField = $("loginTokenField");
    var msgEl = $("loginMsg");
    var btnLogin = $("btnLogin");
    var btnLoginText = $("btnLoginText");
    var btnLoginLoader = $("btnLoginLoader");
    var btnLoginArrow = $("btnLoginArrow");
    var btnConfig = $("btnLoginConfig");
    var btnLocal = $("btnLoginLocal");
    var btnRemote = $("btnRemoteAccess");
    var btnRequest = $("btnRequestInstance");

    function setLoading(isLoading) {
      if (btnLogin) btnLogin.disabled = isLoading;
      if (btnLoginText) btnLoginText.textContent = isLoading ? "Sincronizando..." : "Acessar Sistema";
      if (btnLoginLoader) btnLoginLoader.style.display = isLoading ? "block" : "none";
      if (btnLoginArrow) btnLoginArrow.style.display = isLoading ? "none" : "";
    }

    function showMsg(text, type) {
      if (!msgEl) return;
      msgEl.textContent = text;
      msgEl.className = "login-msg " + (type || "info");
    }

    function checkToken() {
      var val = (tokenEl && tokenEl.value.trim()) || "";
      if (val === REG_TOKEN) {
        if (tokenField) tokenField.classList.add("visible");
        showMsg("Token válido — cadastro liberado", "ok");
      } else {
        if (tokenField) tokenField.classList.remove("visible");
      }
    }

    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var email = (emailEl && emailEl.value.trim().toLowerCase()) || "";
        var pass = (passEl && passEl.value) || "";
        if (!email || !pass) { showMsg("Preencha e-mail e senha.", "err"); return; }
        if (!cfg.webhook) { showMsg("Configure a URL do webhook em Configurar antes.", "err"); return; }
        doLogin(email, pass).then(function (r) {
          if (r.ok && cfg.url && window.lexisOffline) {
            toast("Logado · sincronizando " + r.sess.usuario, "ok-msg");
            syncAll();
          }
        });
        if (passEl) passEl.value = "";
      });
    }

    function enterGo(e) { if (e.key === "Enter" || (e.keyCode && e.keyCode === 13)) { if (btnLogin) btnLogin.click(); } }
    if (emailEl) emailEl.addEventListener("keydown", enterGo);
    if (passEl) passEl.addEventListener("keydown", enterGo);
    if (tokenEl) {
      tokenEl.addEventListener("keydown", enterGo);
      tokenEl.addEventListener("input", checkToken);
      tokenEl.addEventListener("paste", function () { setTimeout(checkToken, 0); });
    }

    if (btnConfig) {
      btnConfig.onclick = function () { setLoginOverlay(false); nav("config"); toast("Confira o webhook e o token, depois volte para o login."); };
    }

    if (btnRemote) {
      btnRemote.addEventListener("click", function () {
        remoteAccessEnabled = !remoteAccessEnabled;
        btnRemote.classList.toggle("active", remoteAccessEnabled);
        btnRemote.setAttribute("aria-pressed", remoteAccessEnabled);
        var txt = remoteAccessEnabled ? "Acesso remoto ATIVADO — app acessível sem login" : "Acesso remoto desativado";
        showMsg(txt, remoteAccessEnabled ? "ok" : "info");
        try { localStorage.setItem("lexis_remote_access", remoteAccessEnabled ? "1" : "0"); } catch(_) {}
      });
      try { if (localStorage.getItem("lexis_remote_access") === "1") { remoteAccessEnabled = true; btnRemote.classList.add("active"); btnRemote.setAttribute("aria-pressed", "true"); } } catch(_) {}
    }

    if (btnLocal) {
      btnLocal.onclick = function () {
        localMode = true;
        sess = null; rowsAll = [];
        try { localStorage.removeItem(LS.sess); } catch (e) {}
        applySessionUI();
        toast("Modo local — sem separação por usuário");
        showMsg("Modo local (sem servidor).", "info");
      };
    }

    if (btnRequest) {
      btnRequest.onclick = function (e) { e.preventDefault(); toast("Redirecionando para solicitação de instância..."); };
    }

    var lo = $("btnLogout");
    if (lo) lo.onclick = logout;
    var eqNew = $("btnEqNew");
    if (eqNew) eqNew.onclick = novoUsuario;
    var eqRef = $("btnEqRefresh");
    if (eqRef) eqRef.onclick = loadEquipe;

    try { if (emailEl) setTimeout(function () { emailEl.focus(); }, 100); } catch(_) {}
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
      if (act === "edit" || act === "sugerir") openEdit(id);
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
    ["qFila", "qCasos"].forEach(function (id) {
      var el = $(id);
      if (el) {
        el.addEventListener("input", function () {
          if (id === "qFila") renderFila();
          if (id === "qCasos") renderCasos();
        });
      }
    });
    ["tfFiltro", "tfPrazo", "tfMeusHoje", "tfSoloMeta"].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener("change", function () { renderFila(); });
    });
    var ta = $("tfMetaAdd"), ts = $("tfMetaSub");
    if (ta) ta.onclick = function () { tfMetaSet(tfMetaV() + 5); renderFila(); };
    if (ts) ts.onclick = function () { tfMetaSet(Math.max(5, tfMetaV() - 5)); renderFila(); };
    var rp = $("repPeriod");
    if (rp) rp.onchange = function () { renderDossie(); };
    document.querySelectorAll(".ag-v").forEach(function (b) {
      b.onclick = function () { agView = b.getAttribute("data-agv"); renderAgenda(); };
    });
    var ap = $("agPrev"), an = $("agNext"), at = $("agToday");
    if (ap) ap.onclick = function () { agAnchor.setDate(agAnchor.getDate() - (agView === "semana" ? 7 : 1)); renderAgenda(); };
    if (an) an.onclick = function () { agAnchor.setDate(agAnchor.getDate() + (agView === "semana" ? 7 : 1)); renderAgenda(); };
    if (at) at.onclick = function () { agAnchor.setHours(12, 0, 0, 0); renderAgenda(); };
  }

  /* ============================ init ============================ */
  loadCfg();
  try {
    var _dbgRaw = localStorage.getItem(LS.dbg);
    if (_dbgRaw) { var _arr = JSON.parse(_dbgRaw); if (Array.isArray(_arr) && _arr.length) syncLog = _arr; }
  } catch (e) {}
  renderConfig();
  bindNav();
  bindCommon();
  bindImport();
  bindScanner();
  bindDossie();
  bindNotas();
  bindConfig();
  bindRows();
  bindLogin();
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
    sess = loadSess();
    applySessionUI();
    if ($("sheetsUrl") && cfg.url) $("sheetsUrl").value = cfg.url;
    if (!localMode && cfg.webhook && !sess) {
      askLogin();
    } else if (sess && sess.token && cfg.webhook) {
      setSyncPill("sessão restaurada", "");
      api("auto", {}).then(function (r) {
        if (r && r.ok && r.json && r.json.ok) {
          logSync("sessão: revalidada", sess.usuario);
          syncAll();
        } else {
          logSync("sessão: expirada", ((r && r.json && r.json.error) || "?"));
          logout();
        }
      }).catch(function () {
        logSync("sessão: sem rede", "will revalidar no proximo sync");
        if (cfg.url && window.lexisOffline) syncAll();
      });
    } else if (cfg.url && window.lexisOffline) {
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