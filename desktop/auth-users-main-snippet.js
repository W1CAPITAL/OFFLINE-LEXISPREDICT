/**
 * Cole no final de desktop/main.js (antes de createMainWindow se preferir).
 * IPC: login, list/create users local + proxy webhook planilha.
 */
const crypto = require("crypto");

function sha256hex(s) {
  return crypto.createHash("sha256").update(String(s || ""), "utf8").digest("hex");
}

function normalizePerfil(p) {
  const s = String(p || "operador").toLowerCase();
  if (/super\s*admin|superadmin/.test(s)) return "superadmin";
  if (/supervis/.test(s)) return "supervisor";
  if (/admin/.test(s)) return "administrador";
  if (/assist/.test(s)) return "assistente";
  return "operador";
}

function ensureUsersInData(data) {
  if (!data || typeof data !== "object") data = {};
  if (!Array.isArray(data.usuarios)) data.usuarios = [];
  if (!data.session) data.session = null;
  if (!data.empresa) {
    data.empresa = {
      id: "d37fd4bb-1c71-4dca-b97e-292355918d39",
      nome: "W1 Capital",
    };
  }
  return data;
}

async function loadDataRaw() {
  const p = dbPath();
  if (!fs.existsSync(p)) return ensureUsersInData({});
  try {
    return ensureUsersInData(JSON.parse(fs.readFileSync(p, "utf8")));
  } catch {
    return ensureUsersInData({});
  }
}

async function saveDataRaw(data) {
  const p = dbPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(ensureUsersInData(data), null, 1), "utf8");
  return p;
}

ipcMain.handle("lexis-auth-login", async (_e, payload) => {
  const login = String(payload?.login || payload?.email || "").trim().toLowerCase();
  const senha = String(payload?.senha || payload?.password || "");
  if (!login || !senha) return { ok: false, error: "login e senha obrigatórios" };

  // 1) tenta webhook planilha
  const webhook = payload?.webhookUrl || "";
  const token = payload?.token || "w1-fase1-2026";
  if (webhook) {
    try {
      const r = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action: "login", login, senha }),
      });
      const j = await r.json();
      if (j && j.ok && j.user) {
        const data = await loadDataRaw();
        data.session = { ...j.user, at: new Date().toISOString() };
        // espelha usuário no JSON local
        const uid = j.user.auth_user_id || j.user.id;
        const ix = data.usuarios.findIndex(
          (u) => String(u.login).toLowerCase() === login || u.auth_user_id === uid
        );
        const row = {
          login: j.user.login,
          nome: j.user.nome,
          senha: sha256hex(senha),
          perfil: normalizePerfil(j.user.perfil),
          escritorio: j.user.escritorio || "",
          ativo: "sim",
          email: j.user.email || login,
          auth_user_id: uid,
          id: j.user.id || uid,
        };
        if (ix >= 0) data.usuarios[ix] = { ...data.usuarios[ix], ...row };
        else data.usuarios.push(row);
        await saveDataRaw(data);
        return { ok: true, user: data.session, source: "sheets" };
      }
    } catch (e) {
      /* cai no local */
    }
  }

  // 2) local
  const data = await loadDataRaw();
  const hash = sha256hex(senha);
  const u = data.usuarios.find((x) => {
    const L = String(x.login || "").toLowerCase();
    const E = String(x.email || "").toLowerCase();
    const ativo = String(x.ativo || "sim").toLowerCase();
    if (ativo === "nao" || ativo === "false") return false;
    return (L === login || E === login) && String(x.senha || "").toLowerCase() === hash;
  });
  if (!u) return { ok: false, error: "usuário ou senha inválidos (local e planilha)" };
  data.session = {
    login: u.login,
    nome: u.nome,
    perfil: normalizePerfil(u.perfil),
    escritorio: u.escritorio || "",
    email: u.email || u.login,
    auth_user_id: u.auth_user_id || u.id,
    id: u.id || u.auth_user_id,
    at: new Date().toISOString(),
  };
  await saveDataRaw(data);
  return { ok: true, user: data.session, source: "local" };
});

ipcMain.handle("lexis-auth-session", async () => {
  const data = await loadDataRaw();
  return { ok: true, session: data.session || null };
});

ipcMain.handle("lexis-auth-logout", async () => {
  const data = await loadDataRaw();
  data.session = null;
  await saveDataRaw(data);
  return { ok: true };
});

ipcMain.handle("lexis-users-list", async (_e, payload) => {
  const data = await loadDataRaw();
  const perfil = normalizePerfil(data.session?.perfil);
  if (!/superadmin|supervisor/.test(perfil)) {
    return { ok: false, error: "só superadmin/supervisor" };
  }
  const webhook = payload?.webhookUrl || "";
  const token = payload?.token || "w1-fase1-2026";
  if (webhook) {
    try {
      const r = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action: "list_users" }),
      });
      const j = await r.json();
      if (j?.ok && Array.isArray(j.users)) return { ok: true, users: j.users, source: "sheets" };
    } catch (_) {}
  }
  return {
    ok: true,
    users: data.usuarios.map((u) => ({
      login: u.login,
      nome: u.nome,
      perfil: u.perfil,
      escritorio: u.escritorio,
      ativo: u.ativo,
      email: u.email,
      auth_user_id: u.auth_user_id,
    })),
    source: "local",
  };
});

ipcMain.handle("lexis-users-create", async (_e, payload) => {
  const data = await loadDataRaw();
  const perfilSess = normalizePerfil(data.session?.perfil);
  if (perfilSess !== "superadmin" && perfilSess !== "supervisor") {
    return { ok: false, error: "sem permissão" };
  }
  const login = String(payload?.login || "").trim().toLowerCase();
  const senha = String(payload?.senha || "");
  const nome = String(payload?.nome || login);
  const perfil = normalizePerfil(payload?.perfil);
  if (!login || !senha) return { ok: false, error: "login/senha" };

  const webhook = payload?.webhookUrl || "";
  const token = payload?.token || "w1-fase1-2026";
  if (webhook) {
    try {
      const r = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          action: "create_user",
          login,
          nome,
          senha,
          perfil,
          escritorio: payload?.escritorio || "",
          email: payload?.email || login,
        }),
      });
      const j = await r.json();
      if (!j?.ok) return { ok: false, error: j?.error || "falha sheets" };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  if (data.usuarios.some((u) => String(u.login).toLowerCase() === login)) {
    return { ok: false, error: "login já existe no local" };
  }
  const id = crypto.randomUUID();
  data.usuarios.push({
    login,
    nome,
    senha: sha256hex(senha),
    perfil,
    escritorio: payload?.escritorio || "",
    ativo: "sim",
    email: (payload?.email || login).toLowerCase(),
    auth_user_id: id,
    id,
  });
  await saveDataRaw(data);
  return { ok: true };
});

ipcMain.handle("lexis-auth-bootstrap-superadmin", async (_e, payload) => {
  const data = await loadDataRaw();
  if (data.usuarios.length > 0) {
    return { ok: false, error: "já existem usuários — use login" };
  }
  const login = String(payload?.login || "admin").trim().toLowerCase();
  const senha = String(payload?.senha || "admin123");
  const id = crypto.randomUUID();
  data.usuarios.push({
    login,
    nome: payload?.nome || "Administrador",
    senha: sha256hex(senha),
    perfil: "superadmin",
    escritorio: payload?.escritorio || "Matriz",
    ativo: "sim",
    email: (payload?.email || login).toLowerCase(),
    auth_user_id: id,
    id,
  });
  data.session = {
    login,
    nome: data.usuarios[0].nome,
    perfil: "superadmin",
    email: data.usuarios[0].email,
    auth_user_id: id,
    id,
    at: new Date().toISOString(),
  };
  await saveDataRaw(data);
  return { ok: true, user: data.session };
});
