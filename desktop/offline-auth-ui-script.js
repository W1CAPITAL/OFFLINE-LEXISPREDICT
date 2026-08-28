/**
 * Cole no final do <script> principal de offline.html
 */
(function authEquipeBoot() {
  const gate = document.getElementById("authGate");
  const api = window.lexisOffline;
  if (!api || !api.authLogin) {
    console.warn("auth IPC ausente — aplique preload + main snippets");
    return;
  }

  function webhook() {
    return (document.getElementById("authWebhook")?.value || localStorage.getItem("lexis_webhook") || "").trim();
  }

  async function showApp() {
    if (gate) gate.style.display = "none";
    const sess = (await api.authSession()).session;
    window.__lexisSession = sess;
    const navEq = document.getElementById("navEquipe");
    if (navEq && sess && /superadmin|supervisor/i.test(sess.perfil || "")) {
      navEq.style.display = "";
    }
    try {
      if (typeof renderAll === "function") renderAll();
    } catch (_) {}
  }

  async function requireAuth() {
    const s = await api.authSession();
    if (s?.session) {
      await showApp();
      return;
    }
    if (gate) {
      gate.style.display = "flex";
      const w = localStorage.getItem("lexis_webhook");
      if (w && document.getElementById("authWebhook")) document.getElementById("authWebhook").value = w;
    }
  }

  document.getElementById("authBtn")?.addEventListener("click", async () => {
    const err = document.getElementById("authErr");
    err.textContent = "";
    const login = document.getElementById("authLogin").value;
    const senha = document.getElementById("authSenha").value;
    const wh = webhook();
    if (wh) localStorage.setItem("lexis_webhook", wh);
    const r = await api.authLogin({ login, senha, webhookUrl: wh, token: localStorage.getItem("lexis_token") || "w1-fase1-2026" });
    if (!r.ok) {
      err.textContent = r.error || "falha";
      return;
    }
    await showApp();
  });

  document.getElementById("authBootstrap")?.addEventListener("click", async () => {
    const err = document.getElementById("authErr");
    const login = document.getElementById("authLogin").value || "admin";
    const senha = document.getElementById("authSenha").value || "admin123";
    const r = await api.authBootstrapSuperadmin({ login, senha, nome: "Administrador" });
    if (!r.ok) {
      err.textContent = r.error || "falha";
      return;
    }
    err.style.color = "#4ade80";
    err.textContent = "Superadmin criado. Entrando…";
    await showApp();
  });

  document.getElementById("eqCreate")?.addEventListener("click", async () => {
    const wh = localStorage.getItem("lexis_webhook") || "";
    const r = await api.usersCreate({
      login: document.getElementById("eqLogin").value,
      nome: document.getElementById("eqNome").value,
      senha: document.getElementById("eqSenha").value,
      perfil: document.getElementById("eqPerfil").value,
      escritorio: document.getElementById("eqEsc").value,
      email: document.getElementById("eqEmail").value,
      webhookUrl: wh,
      token: localStorage.getItem("lexis_token") || "w1-fase1-2026",
    });
    alert(r.ok ? "Usuário criado" : r.error || "erro");
    if (r.ok) loadEquipe();
  });

  async function loadEquipe() {
    const box = document.getElementById("eqTable");
    if (!box) return;
    const wh = localStorage.getItem("lexis_webhook") || "";
    const r = await api.usersList({ webhookUrl: wh, token: localStorage.getItem("lexis_token") || "w1-fase1-2026" });
    if (!r.ok) {
      box.innerHTML = "<p class='hint'>" + (r.error || "") + "</p>";
      return;
    }
    box.innerHTML =
      "<table><thead><tr><th>Login</th><th>Nome</th><th>Perfil</th><th>Ativo</th><th>E-mail</th></tr></thead><tbody>" +
      (r.users || [])
        .map(
          (u) =>
            "<tr><td>" +
            u.login +
            "</td><td>" +
            (u.nome || "") +
            "</td><td>" +
            (u.perfil || "") +
            "</td><td>" +
            (u.ativo || "") +
            "</td><td>" +
            (u.email || "") +
            "</td></tr>"
        )
        .join("") +
      "</tbody></table>";
  }

  // hook nav equipe
  document.querySelectorAll("[data-nav=equipe]").forEach((btn) => {
    btn.addEventListener("click", () => loadEquipe());
  });

  // filtro de carteira por perfil (se existir array cases global)
  window.lexisCanSeeAllCases = function () {
    const p = window.__lexisSession?.perfil || "";
    return /superadmin|supervisor/i.test(p);
  };
  window.lexisFilterCasesByOwner = function (list) {
    if (!Array.isArray(list)) return list;
    if (window.lexisCanSeeAllCases()) return list;
    const uid = window.__lexisSession?.auth_user_id;
    if (!uid) return list;
    return list.filter((c) => String(c.created_by || c.createdBy || "") === String(uid));
  };

  requireAuth();
})();
