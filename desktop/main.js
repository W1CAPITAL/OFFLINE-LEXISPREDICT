/**
 * Lexis Gabinete v6.0
 * Offline-first + DataJud/DJEN + DB em arquivo + Sync Google Sheets (2 vias)
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, session, nativeTheme } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const zlib = require("zlib");

const GABINETE_URL = "https://private-assecom.vercel.app";
const PARTITION = "persist:lexis-offline-v5.1";
const DATAJUD_KEY =
  process.env.DATAJUD_API_KEY ||
  "cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==";
const DJEN_URL = "https://comunicaapi.pje.jus.br/api/v1/comunicacao";

const COURT_ALIASES = {
  "8.01": "tjac", "8.02": "tjal", "8.03": "tjap", "8.04": "tjam", "8.05": "tjba",
  "8.06": "tjce", "8.07": "tjdft", "8.08": "tjes", "8.09": "tjgo", "8.10": "tjma",
  "8.11": "tjmt", "8.12": "tjms", "8.13": "tjmg", "8.14": "tjpa", "8.15": "tjpb",
  "8.16": "tjpr", "8.17": "tjpe", "8.18": "tjpi", "8.19": "tjrj", "8.20": "tjrn",
  "8.21": "tjrs", "8.22": "tjro", "8.23": "tjrr", "8.24": "tjsc", "8.25": "tjse",
  "8.26": "tjsp", "8.27": "tjto", "4.01": "trf1", "4.02": "trf2", "4.03": "trf3",
  "4.04": "trf4", "4.05": "trf5", "4.06": "trf6",
};

app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=4096");
nativeTheme.themeSource = "dark";

let mainWindow = null;
let splashWindow = null;
let shown = false;

function appPath(...p) { return path.join(__dirname, ...p); }
function userDataPath(...p) {
  return path.join(app.getPath("userData"), ...p);
}
function dbPath() {
  return userDataPath("lexis-offline-db.json");
}

function fetchBuffer(url, opts, maxRedirects) {
  if (maxRedirects === undefined) maxRedirects = 6;
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const u = new URL(url);
    const hdrs = Object.assign({}, opts.headers || {});
    if (opts.body && hdrs["Content-Length"] === undefined) {
      hdrs["Content-Length"] = Buffer.byteLength(String(opts.body));
    }
    const reqOpts = {
      hostname: u.hostname,
      port: u.port || (url.startsWith("https") ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || "GET",
      headers: hdrs,
      timeout: opts.timeout || 60000,
    };
    const req = lib.request(reqOpts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        if (String(next).toLowerCase().indexOf("accounts.google") > -1) {
          const c2 = [];
          res.on("data", (cd) => c2.push(cd));
          res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c2), headers: res.headers, authRedirect: true }));
          return;
        }
        res.resume();
        if ((opts.method === "POST" || opts.method === "PUT") &&
            (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303)) {
          const fol = Object.assign({}, opts, { method: "GET", body: null, headers: Object.assign({}, opts.headers || {}) });
          delete fol.headers["Content-Length"];
          return resolve(fetchBuffer(next, fol, maxRedirects - 1));
        }
        return resolve(fetchBuffer(next, opts, maxRedirects - 1));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        if (enc.indexOf("gzip") >= 0 || enc.indexOf("deflate") >= 0) {
          zlib.gunzip(buf, (err, out) => {
            resolve({ status: res.statusCode, body: err ? buf : out, headers: res.headers });
          });
        } else {
          resolve({ status: res.statusCode, body: buf, headers: res.headers });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}


const BUILTIN_MINIMAX = {
  minimaxApiKey: "",
  minimaxApiKeyAlt: "",
  minimaxModel: "MiniMax-M2.5",
};
function loadLocalSecrets() {
  const base = Object.assign({}, BUILTIN_MINIMAX);
  try {
    const p = path.join(path.dirname(process.execPath), "lexis-secrets.json");
    if (fs.existsSync(p)) Object.assign(base, JSON.parse(fs.readFileSync(p, "utf8")));
  } catch (_) {}
  try {
    const p2 = path.join(app.getPath("userData"), "lexis-secrets.json");
    if (fs.existsSync(p2)) Object.assign(base, JSON.parse(fs.readFileSync(p2, "utf8")));
  } catch (_) {}
  return base;
}

function sheetsCsvCandidates(raw) {
  const u = String(raw || "").trim();
  const m = u.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) return [u];
  const id = m[1];
  const g = u.match(/[?#&]gid=([0-9]+)/);
  const hasGid = !!g;
  const gid = g ? g[1] : "0";
  const suf = hasGid ? "&gid=" + gid : "";
  // Sem gid no link (?usp=sharing perde o gid), o /export sem gid devolve a
  // primeira aba — e /export&gid=0 pode dar 400 se gid 0 não existir.
  const cands = [];
  cands.push("https://docs.google.com/spreadsheets/d/" + id + "/export?format=csv" + suf);
  cands.push("https://docs.google.com/spreadsheets/d/" + id + "/gviz/tq?tqx=out:csv" + suf);
  cands.push("https://docs.google.com/spreadsheets/d/" + id + "/pub?output=csv" + suf);
  return cands;
}

function resolveAlias(cnj) {
  const digits = String(cnj || "").replace(/\D/g, "");
  if (digits.length !== 20) return "tjsp";
  const part = digits[13] + "." + digits.substring(14, 16);
  return COURT_ALIASES[part] || "tjsp";
}

function maskCnj(digits) {
  const d = String(digits).replace(/\D/g, "");
  if (d.length !== 20) return d;
  return d.slice(0, 7) + "-" + d.slice(7, 9) + "." + d.slice(9, 13) + "." + d.slice(13, 14) + "." + d.slice(14, 16) + "." + d.slice(16);
}

ipcMain.handle("lexis-fetch-text", async (_e, url) => {
  const candidates = sheetsCsvCandidates(url);
  let lastErr = "";
  for (const finalUrl of candidates) {
    try {
      const r = await fetchBuffer(finalUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 LexisOffline/4.0",
          Accept: "text/csv,text/plain,*/*",
        },
      });
      if (r.status === 200) {
        const t = r.body.toString("utf8");
        if (t && t.trim().length > 3 && !/<html|<body|<head/i.test(t.slice(0, 500))) {
          return { ok: true, text: t, url: finalUrl };
        }
        lastErr = "resposta sem CSV (publique o link)";
      } else {
        lastErr = "HTTP " + r.status;
      }
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  return { ok: false, error: lastErr || "Falha ao baixar planilha" };
});

ipcMain.handle("lexis-fetch-json", async (_e, url, opts) => {
  try {
    let finalUrl = String(url || "").trim();
    if (finalUrl && /^https:\/\/script\.google\.com\/macros\/s\//.test(finalUrl)) {
      finalUrl = finalUrl.replace(/\/dev(\b|$)/, "/exec");
    }
    const r = await fetchBuffer(finalUrl, {
      method: (opts && opts.method) || "GET",
      headers: Object.assign(
        { "User-Agent": "Mozilla/5.0 LexisOffline/6.0", Accept: "application/json" },
        (opts && opts.headers) || {}
      ),
      body: opts && opts.body,
      timeout: (opts && opts.timeout) || 45000,
    });
    const text = r.body.toString("utf8");
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    if (r.authRedirect) {
      return { ok: false, http: r.status, auth: true, json: null, raw: "Google redirecionou para login. Verifique se a implantação web está com acesso 'Qualquer pessoa' (sem 'com o link')." };
    }
    return { ok: r.status >= 200 && r.status < 300 && !!json, http: r.status, text, json, raw: text.slice(0, 500) };
  } catch (e) {
    return { ok: false, http: 0, error: e.message || String(e), raw: "" };
  }
});

ipcMain.handle("lexis-datajud", async (_e, cnj) => {
  try {
    const digits = String(cnj || "").replace(/\D/g, "");
    if (digits.length !== 20) return { ok: false, error: "CNJ precisa de 20 dígitos (ex: 0001234-56.2024.8.26.0100). Cole o número completo." };
    const alias = resolveAlias(digits);
    const masked = maskCnj(digits);
    const url = "https://api-publica.datajud.cnj.jus.br/api_publica_" + alias + "/_search";
    // Espelha LexisPredict fetchDataJud: number sem máscara + size maior
    const queries = [
      { size: 10, query: { match: { number: digits } } },
      { size: 10, query: { term: { number: digits } } },
      { size: 10, query: { match: { number: masked } } },
      { size: 10, query: { bool: { should: [
          { match_phrase: { number: masked } },
          { match: { number: digits } },
        ], minimum_should_match: 1 } } },
    ];
    let json = null;
    let lastStatus = 0;
    let lastText = "";
    for (const bodyObj of queries) {
      const r = await fetchBuffer(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "APIKey " + DATAJUD_KEY,
          "User-Agent": "LexisOffline/5.1.2",
        },
        body: JSON.stringify(bodyObj),
        timeout: 35000,
      });
      lastStatus = r.status;
      lastText = r.body.toString("utf8");
      try { json = JSON.parse(lastText); } catch (_) { json = null; }
      const hitsTry = (json && json.hits && json.hits.hits) || [];
      if (r.status === 200 && hitsTry.length) break;
    }
    if (lastStatus !== 200) return { ok: false, error: "DataJud HTTP " + lastStatus, status: lastStatus, text: lastText.slice(0, 500), alias };
    const hits = (json && json.hits && json.hits.hits) || [];
    const src = hits[0] && hits[0]._source ? hits[0]._source : null;
    let movs = (src && (src.movimentos || src.movements)) || [];
    if (!Array.isArray(movs)) movs = [];
    // ordenar por data se houver
    movs = movs.slice().sort(function (a, b) {
      const da = String(a.dataHora || a.dateTime || a.data || "");
      const db = String(b.dataHora || b.dateTime || b.data || "");
      return da.localeCompare(db);
    });
    const last = movs.length ? movs[movs.length - 1] : null;
    return {
      ok: true,
      alias,
      cnj: digits,
      found: !!src,
      source: src ? { tribunal: src.tribunal, classe: src.classe, grau: src.grau, assuntos: src.assuntos } : null,
      ultimoNome: last && (last.nome || last.name || last.descricao) || null,
      ultimoData: last && (last.dataHora || last.dateTime || last.data) || null,
      movimentosCount: movs.length,
      movimentos: movs.slice(-20).map(function (m) {
        return {
          nome: m.nome || m.name || m.descricao || "",
          data: m.dataHora || m.dateTime || m.data || "",
        };
      }),
      nota: src ? null : "DataJud sem hit neste tribunal (comum em processos novos ou não indexados). Use DJEN.",
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle("lexis-djen", async (_e, cnj, opts) => {
  try {
    const digits = String(cnj || "").replace(/\D/g, "");
    if (digits.length !== 20) return { ok: false, error: "CNJ precisa de 20 dígitos. Cole o número completo do processo." };
    const dataFim = (opts && opts.dataFim) || new Date().toISOString().slice(0, 10);
    const dataInicio =
      (opts && opts.dataInicio) ||
      new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const variants = [digits, maskCnj(digits)];
    let lastErr = "";
    for (const v of variants) {
      const params = new URLSearchParams({
        numeroProcesso: v,
        dataDisponibilizacaoInicio: dataInicio,
        dataDisponibilizacaoFim: dataFim,
        pagina: "1",
        itensPorPagina: "30",
      });
      const r = await fetchBuffer(DJEN_URL + "?" + params.toString(), {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122 LexisOffline/4.0",
          Origin: "https://comunica.pje.jus.br",
          Referer: "https://comunica.pje.jus.br/",
        },
        timeout: 30000,
      });
      if (r.status === 403) return { ok: false, error: "DJEN 403 (rede/geo)", status: 403 };
      if (r.status === 429) return { ok: false, error: "DJEN 429 rate limit", status: 429 };
      if (r.status !== 200) { lastErr = "HTTP " + r.status; continue; }
      let json = null;
      try { json = JSON.parse(r.body.toString("utf8")); } catch (_) {}
      const items = (json && (json.items || json.comunicacoes || json.content)) || [];
      const list = Array.isArray(items) ? items : [];
      return {
        ok: true,
        count: list.length,
        items: list.slice(0, 20).map((it) => ({
          data: it.data_disponibilizacao || it.dataDisponibilizacao || it.data || null,
          tipo: it.tipoComunicacao || it.tipo || it.siglaTribunal || "",
          texto: (it.texto || it.conteudo || it.resumo || it.destinatarios || "").toString().slice(0, 1200),
          link: it.link || (it.hash ? "https://comunica.pje.jus.br/consulta?hash=" + it.hash : null),
        })),
      };
    }
    return { ok: false, error: lastErr || "DJEN sem retorno" };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle("lexis-db-load", async () => {
  try {
    const p = dbPath();
    let src = p;
    if (!fs.existsSync(src)) {
      const appData = app.getPath("appData");
      const legacy = [
        path.join(appData, "lexis-gabinete-desktop", "lexis-offline-db.json"),
        path.join(appData, "lexis-offline", "lexis-offline-db.json"),
        path.join(appData, "lexis-offline-edition", "lexis-offline-db.json"),
        path.join(appData, "lexis-offline-legacy-shell", "lexis-offline-db.json"),
        path.join(path.dirname(process.execPath), "lexis-offline-db.json"),
      ];
      for (const lp of legacy) {
        if (fs.existsSync(lp)) { src = lp; break; }
      }
    }
    if (!fs.existsSync(src)) return { ok: true, data: null, path: p, source: null };
    const raw = fs.readFileSync(src, "utf8");
    const data = JSON.parse(raw);
    if (src !== p) {
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, raw, "utf8");
      } catch (_) {}
    }
    return { ok: true, data, path: p, source: src };
  } catch (e) {
    return { ok: false, error: e.message, path: dbPath() };
  }
});

ipcMain.handle("lexis-db-save", async (_e, data) => {
  try {
    const p = dbPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // compacto (um espaço por nível) = ~5x mais rápido que pretty-print; evita travar com carteiras grandes
    fs.writeFileSync(p, JSON.stringify(data, null, 1), "utf8");
    // espelho ao lado do exe também compacto (se possível)
    try {
      const mirror = path.join(path.dirname(process.execPath), "lexis-offline-db.json");
      if (!process.execPath.includes("node")) fs.writeFileSync(mirror, JSON.stringify(data, null, 1), "utf8");
    } catch (_) {}
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("lexis-export-csv", async (_e, csv, name) => {
  try {
    const { filePath, canceled } = await dialog.showSaveDialog({
      defaultPath: name || "lexis-carteira.csv",
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, csv, "utf8");
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("lexis-ai-chat", async (_e, payload) => {
  const provider = (payload && payload.provider) || "ollama";
  const prompt = (payload && payload.prompt) || "";
  const system = (payload && payload.system) || "Você é o assistente Lexis Offline. Responda em português, objetivo, para operação de carteira jurídica.";
  if (!prompt.trim()) return { ok: false, error: "Prompt vazio" };

  try {
    if (provider === "ollama") {
      let model = (payload && payload.model) || "qwen2.5:0.5b";
      // 1) Descobre modelos instalados (evita 404 por nome errado)
      try {
        const tags = await fetchBuffer("http://127.0.0.1:11434/api/tags", {
          method: "GET",
          timeout: 8000,
        });
        if (tags.status === 200) {
          const tj = JSON.parse(tags.body.toString("utf8"));
          const names = (tj.models || []).map((m) => m.name || m.model).filter(Boolean);
          if (names.length) {
            if (!names.includes(model)) {
              const prefer = names.find((n) => /qwen2\.5:0\.5b/i.test(n))
                || names.find((n) => /qwen|smollm|tinyllama|phi|gemma/i.test(n))
                || names[0];
              model = prefer;
            }
          } else {
            return {
              ok: false,
              error: "Ollama rodando, mas sem modelos. Rode: ollama pull qwen2.5:0.5b",
            };
          }
        }
      } catch (_) { /* tags opcional */ }

      // 2) /api/chat (Ollama atual)
      let r = await fetchBuffer("http://127.0.0.1:11434/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
        }),
        timeout: 120000,
      });

      // 3) Fallback /api/generate se 404 (builds antigas do Ollama)
      if (r.status === 404) {
        r = await fetchBuffer("http://127.0.0.1:11434/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            stream: false,
            prompt: system + "\n\nUsuário: " + prompt + "\n\nAssistente:",
          }),
          timeout: 120000,
        });
      }

      if (r.status !== 200) {
        const bodyHint = (r.body && r.body.toString("utf8") || "").slice(0, 180);
        return {
          ok: false,
          error:
            "Ollama HTTP " +
            r.status +
            " (modelo: " +
            model +
            "). Abra o app Ollama, rode 2-INSTALAR-OLLAMA-IA.bat e: ollama pull qwen2.5:0.5b. " +
            bodyHint,
        };
      }
      const json = JSON.parse(r.body.toString("utf8"));
      const text = (json.message && json.message.content) || json.response || "";
      return { ok: true, text, provider: "ollama", model };
    }

    if (provider === "openrouter") {
      const key = (payload && payload.apiKey) || process.env.OPENROUTER_API_KEY || "";
      if (!key) return { ok: false, error: "Configure OPENROUTER_API_KEY em Configurações" };
      const model = (payload && payload.model) || "meta-llama/llama-3.2-3b-instruct:free";
      const r = await fetchBuffer("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + key,
          "HTTP-Referer": "https://lexis-offline.local",
          "X-Title": "Lexis Offline",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
        }),
        timeout: 90000,
      });
      const textBody = r.body.toString("utf8");
      if (r.status !== 200) return { ok: false, error: "OpenRouter " + r.status + ": " + textBody.slice(0, 200) };
      const json = JSON.parse(textBody);
      const text = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
      return { ok: true, text: text || "", provider: "openrouter", model };
    }


    if (provider === "minimax" || provider === "minimax-cloud") {
      const secrets = loadLocalSecrets();
      const keys = [];
      const k1 = (payload && (payload.apiKey || payload.minimaxKey)) || "";
      if (k1) keys.push(k1);
      if (secrets.minimaxApiKey) keys.push(secrets.minimaxApiKey);
      if (secrets.minimaxApiKeyAlt) keys.push(secrets.minimaxApiKeyAlt);
      if (process.env.MINIMAX_API_KEY) keys.push(process.env.MINIMAX_API_KEY);
      const uniq = [];
      keys.forEach(function (k) { if (k && uniq.indexOf(k) < 0) uniq.push(k); });
      if (!uniq.length) {
        return {
          ok: false,
          error: "Sem chave MiniMax. Coloque lexis-secrets.json ao lado do EXE ou cole sk-api- no campo API.",
        };
      }
      const model = (payload && payload.model) || secrets.minimaxModel || "MiniMax-M2.5";
      const endpoints = [
        "https://api.minimax.io/v1/chat/completions",
        "https://api.minimax.io/v1/text/chatcompletion_v2",
        "https://api.minimaxi.com/v1/text/chatcompletion_v2",
      ];
      let lastErr = "";
      for (const key of uniq) {
      for (const url of endpoints) {
        try {
          const body = {
            model,
            stream: false,
            messages: [
              { role: "system", name: "Lexis", content: system },
              { role: "user", name: "user", content: prompt },
            ],
          };
          const r = await fetchBuffer(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + key,
            },
            body: JSON.stringify(body),
            timeout: 120000,
          });
          const textBody = r.body.toString("utf8");
          if (r.status !== 200) {
            lastErr = "MiniMax " + r.status + " @ " + url + ": " + textBody.slice(0, 160);
            continue;
          }
          const json = JSON.parse(textBody);
          let text = "";
          if (json.choices && json.choices[0]) {
            const m = json.choices[0].message || json.choices[0].delta || {};
            text = m.content || "";
          }
          text = text || json.reply || json.response || "";
          if (json.base_resp && json.base_resp.status_code && json.base_resp.status_code !== 0) {
            lastErr = "MiniMax base_resp: " + (json.base_resp.status_msg || json.base_resp.status_code);
            continue;
          }
          if (!text) {
            lastErr = "MiniMax resposta vazia: " + textBody.slice(0, 120);
            continue;
          }
          return { ok: true, text, provider: "minimax", model, endpoint: url };
        } catch (e) {
          lastErr = e && e.message ? e.message : String(e);
        }
      }
      } // keys
      return { ok: false, error: lastErr || "MiniMax falhou em todos os endpoints/chaves" };
    }

    return { ok: false, error: "Provider desconhecido: " + provider };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (/ECONNREFUSED/i.test(msg)) {
      return { ok: false, error: "Ollama não está rodando em 127.0.0.1:11434. Instale, abra o Ollama e rode: ollama pull qwen2.5:0.5b" };
    }
    return { ok: false, error: msg };
  }
});


ipcMain.handle("lexis-sheets-push", async (_e, payload) => {
  try {
    const url = String((payload && payload.webhookUrl) || "").trim();
    if (!url || !/^https:\/\/script\.google\.com\//i.test(url)) {
      return {
        ok: false,
        error: "Configure a URL do Apps Script (deploy como aplicativo da web). Ver docs/SHEETS_WRITE_APPS_SCRIPT.md",
      };
    }
    const rows = (payload && payload.rows) || [];
    if (!Array.isArray(rows) || !rows.length) {
      return { ok: false, error: "Nenhuma linha para enviar" };
    }
    // Apps Script free: lotes de até 50
    const batch = rows.slice(0, 50).map(function (r) {
      return {
        protocolo: String(r.protocolo || "").trim(),
        ultimo: String(r.ultimo || "").trim(),
        prazo: String(r.prazo || "").trim(),
        obs: String(r.obs || r.movimentacao || "").trim(),
        status: String(r.status || "").trim(),
        cliente: String(r.cliente || "").trim(),
      };
    });
    const body = JSON.stringify({
      action: "upsertRetornos",
      sheetGid: (payload && payload.gid) || null,
      rows: batch,
    });
    const r = await fetchBuffer(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "LexisOffline/5.1.8" },
      body,
      timeout: 60000,
    });
    const text = r.body.toString("utf8");
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    if (r.status >= 200 && r.status < 400) {
      return { ok: true, status: r.status, result: json || text, sent: batch.length };
    }
    return { ok: false, status: r.status, error: (json && json.error) || text.slice(0, 400) };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle("lexis-open-external", async (_e, url) => {
  if (url && /^https?:/i.test(url)) await shell.openExternal(url);
  return true;
});

ipcMain.handle("lexis-secrets-status", async () => {
  const secrets = loadLocalSecrets();
  return {
    hasKey: !!(secrets.minimaxApiKey || secrets.minimaxApiKeyAlt),
    model: secrets.minimaxModel || "MiniMax-M2.5",
  };
});

ipcMain.handle("lexis-paths", async () => ({
  db: dbPath(),
  userData: app.getPath("userData"),
  exe: process.execPath,
}));

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 460, height: 300, frame: false, resizable: false, center: true,
    alwaysOnTop: true, skipTaskbar: true, backgroundColor: "#09090b", show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splashWindow.loadFile(appPath("splash.html"));
  splashWindow.on("closed", () => { splashWindow = null; });
}
function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) try { splashWindow.close(); } catch (_) {}
  splashWindow = null;
}
function revealMain() {
  if (shown || !mainWindow || mainWindow.isDestroyed()) return;
  shown = true; closeSplash(); mainWindow.show(); mainWindow.focus();
}
function loadOffline() { if (mainWindow) mainWindow.loadFile(appPath("offline.html")); }
function loadOnline() { if (mainWindow) mainWindow.loadURL(GABINETE_URL); }

function createMainWindow() {
  const ses = session.fromPartition(PARTITION, { cache: true });
  mainWindow = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1100, minHeight: 700, show: false,
    backgroundColor: "#0f172a", title: "Lexis Gabinete 6.0",
    webPreferences: {
      preload: appPath("preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      session: ses,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  mainWindow.webContents.on("did-finish-load", () => setTimeout(revealMain, 180));
  mainWindow.webContents.on("did-fail-load", (_e, _c, _d, url) => {
    if (url && url.indexOf("private-assecom") >= 0) loadOffline();
  });
  loadOffline();
  mainWindow.on("closed", () => { mainWindow = null; });
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "Lexis",
      submenu: [
        { label: "Offline", accelerator: "CmdOrCtrl+2", click: () => loadOffline() },
        { label: "Online (Vercel)", accelerator: "CmdOrCtrl+1", click: () => loadOnline() },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { label: "Exibir", submenu: [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }] },
  ]));
}

app.whenReady().then(() => {
  createSplash();
  buildMenu();
  createMainWindow();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
