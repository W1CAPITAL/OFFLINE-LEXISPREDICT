/**
 * Lexis Gabinete Desktop — casca Electron
 * Objetivo: mesma UI/funções do LexisPredict (Next), não offline.html paralelo.
 *
 * Modos:
 *  1) LEXIS_URL  → abre o app (local next start ou build)
 *  2) fallback   → offline.html (só emergência / parser planilha)
 */
const { app, BrowserWindow, shell, ipcMain } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");

const APP_VERSION = "6.0.0-desktop";
let mainWindow = null;
let nextProc = null;

function userData(...p) {
  return path.join(app.getPath("userData"), ...p);
}

function waitForUrl(url, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve(true);
        else retry();
      });
      req.on("error", retry);
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) reject(new Error("Timeout esperando Lexis em " + url));
      else setTimeout(tick, 800);
    };
    tick();
  });
}

function findLexisRoot() {
  const candidates = [
    process.env.LEXIS_ROOT,
    path.join(process.cwd(), "LexisPredict"),
    path.join(process.cwd(), "..", "LexisPredict"),
    path.join(__dirname, "..", "LexisPredict"),
    path.join(__dirname, "..", "..", "LexisPredict"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "package.json"))) {
        const pkg = JSON.parse(fs.readFileSync(path.join(c, "package.json"), "utf8"));
        if (pkg.name === "lexispredict" || fs.existsSync(path.join(c, "src", "app"))) return c;
      }
    } catch (_) {}
  }
  return null;
}

function startNext(lexisRoot) {
  const port = process.env.PORT || "3000";
  const env = Object.assign({}, process.env, {
    PORT: port,
    NODE_ENV: "production",
  });
  // prefere next start (precisa de build prévio)
  const nextBin = path.join(lexisRoot, "node_modules", "next", "dist", "bin", "next");
  const cmd = fs.existsSync(nextBin) ? process.execPath : "npx";
  const args = fs.existsSync(nextBin)
    ? [nextBin, "start", "-p", port]
    : ["next", "start", "-p", port];
  nextProc = spawn(cmd, args, {
    cwd: lexisRoot,
    env,
    shell: process.platform === "win32",
    stdio: "pipe",
  });
  nextProc.stdout && nextProc.stdout.on("data", (d) => console.log("[next]", String(d).trim()));
  nextProc.stderr && nextProc.stderr.on("data", (d) => console.error("[next]", String(d).trim()));
  return "http://127.0.0.1:" + port;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "LexisPredict Desktop v" + APP_VERSION,
    backgroundColor: "#FAFAF7",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  const forced = process.env.LEXIS_URL;
  const lexisRoot = findLexisRoot();
  let target = forced || null;

  if (!target && lexisRoot) {
    try {
      console.log("Lexis root:", lexisRoot);
      target = startNext(lexisRoot);
      await waitForUrl(target, 120000);
    } catch (e) {
      console.error("Falha ao subir Next:", e.message);
      target = null;
    }
  }

  if (target) {
    await mainWindow.loadURL(target);
  } else {
    // fallback shell (não é o Lexis completo)
    const fallback = path.join(__dirname, "..", "desktop", "offline.html");
    if (fs.existsSync(fallback)) {
      await mainWindow.loadFile(fallback);
    } else {
      await mainWindow.loadURL(
        "data:text/html;charset=utf-8," +
          encodeURIComponent(
            "<h1>Lexis Desktop</h1><p>Clone LexisPredict ao lado deste repo e rode scripts/1-SETUP-LEXIS-DESKTOP.bat</p>"
          )
      );
    }
  }
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (nextProc) try { nextProc.kill(); } catch (_) {}
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => {
  if (nextProc) try { nextProc.kill(); } catch (_) {}
});

ipcMain.handle("desktop:version", () => APP_VERSION);
ipcMain.handle("desktop:paths", () => ({
  userData: app.getPath("userData"),
  lexisRoot: findLexisRoot(),
}));
