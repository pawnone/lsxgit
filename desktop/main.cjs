const {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  net,
  dialog,
  shell,
  Menu,
} = require("electron");
const path = require("node:path"),
  fs = require("node:fs/promises"),
  { pathToFileURL } = require("node:url"),
  crypto = require("node:crypto");
app.setName("文青尚品");
if (process.env.WQ_APP_DATA_DIR)
  app.setPath("userData", path.resolve(process.env.WQ_APP_DATA_DIR));
protocol.registerSchemesAsPrivileged([
  {
    scheme: "wqapp",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  { scheme: "wqasset", privileges: { standard: true, secure: true } },
]);
let win,
  service,
  exitAfterCurrent = false;
const media = new Map(),
  tokens = new Map(),
  APP_URL = "wqapp://app/index.html";
const project = path.resolve(__dirname, "..");
function publicState() {
  const s = service.snapshot();
  for (const p of s.products)
    if (p.image) {
      let token = tokens.get(p.image);
      if (!token) {
        token = crypto.randomUUID();
        tokens.set(p.image, token);
        media.set(token, p.image);
      }
      p.image = "wqasset://media/" + token;
    }
  return s;
}
function sendState() {
  if (win && !win.isDestroyed())
    win.webContents.send("wqapp:state", publicState());
  if (exitAfterCurrent && !service.running) app.quit();
}
async function handle(op, p = {}) {
  switch (op) {
    case "state":
      return publicState();
    case "choose-root": {
      service.ensureIdle();
      const d = await dialog.showOpenDialog(win, {
        title: "选择总商品素材库",
        properties: ["openDirectory"],
      });
      if (!d.canceled) await service.setRoot(d.filePaths[0]);
      return publicState();
    }
    case "scan":
      await service.scan();
      return publicState();
    case "add-shop":
      await service.addShop(p.name, p.platform);
      return publicState();
    case "select":
      await service.select(p);
      return publicState();
    case "open-login":
      return service.openLogin(p.id, { fresh: p.fresh === true });
    case "refresh-shops":
      await service.refreshShops();
      return publicState();
    case "verify":
      await service.verify(p.id, {
        acknowledgeSafety: p.acknowledgeSafety === true,
      });
      return publicState();
    case "check":
      await service.check({ mode: p.mode || "normal" });
      return publicState();
    case "start":
      await service.start(p.token);
      return publicState();
    case "pause":
      await service.pause();
      return publicState();
    case "resume":
      await service.resume();
      return publicState();
    case "stop":
      await service.stopAfterCurrent();
      return publicState();
    case "open-report": {
      const r =
        service.history.find((r) => r.id === p.id) ||
        (service.run?.id === p.id && service.run);
      if (!r) throw Error("未找到本批记录");
      const file = path.join(service.root, "runs", r.id, "run.json");
      const error = await shell.openPath(file);
      if (error) throw Error(error);
      return true;
    }
    case "export-report": {
      const r =
        service.history.find((r) => r.id === p.id) ||
        (service.run?.id === p.id && service.run);
      if (!r) throw Error("未找到本批记录");
      const out = await dialog.showSaveDialog(win, {
        title: "导出本批报告",
        defaultPath: "文青尚品-" + r.id + ".json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!out.canceled)
        await fs.writeFile(
          out.filePath,
          JSON.stringify(
            { app: "文青尚品", version: app.getVersion(), run: r },
            null,
            2,
          ),
        );
      return !out.canceled;
    }
    default:
      throw Error("未开放的本机操作");
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      const { ProcessRunner } = await import("./process-runner.mjs"),
        { BrowserManager } = await import("./browser-manager.mjs"),
        { ListingService } = await import("./service.mjs");
      const root = app.getPath("userData"),
        runner = new ProcessRunner({
          execPath: process.execPath,
          electron: true,
        });
      const browser = new BrowserManager({
        root: path.join(root, "browser-profiles"),
        runner,
      });
      service = new ListingService({
        root,
        runner,
        browser,
        version: app.getVersion(),
      });
      await service.init();
      const routes = {
        "/index.html": path.join(__dirname, "ui/index.html"),
        "/renderer.js": path.join(__dirname, "ui/renderer.js"),
        "/native.css": path.join(__dirname, "ui/native.css"),
        "/style.css": path.join(project, "demo/style.css"),
        "/task-plan.js": path.join(project, "demo/task-plan.js"),
      };
      protocol.handle("wqapp", async (req) => {
        const u = new URL(req.url);
        if (u.hostname !== "app")
          return new Response("Not found", { status: 404 });
        let file = routes[u.pathname];
        if (!file && u.pathname.startsWith("/assets/icons/")) {
          const name = path.basename(u.pathname);
          if (name.endsWith(".svg"))
            file = path.join(project, "demo/assets/icons", name);
        }
        if (!file) return new Response("Not found", { status: 404 });
        try {
          const response = await net.fetch(pathToFileURL(file).href);
          return response;
        } catch {
          return new Response("Not found", { status: 404 });
        }
      });
      protocol.handle("wqasset", async (req) => {
        const token = new URL(req.url).pathname.slice(1),
          file = media.get(token);
        if (!file) return new Response("Not found", { status: 404 });
        const root = service.config.materialsRoot;
        if (!root) return new Response("Forbidden", { status: 403 });
        try {
          const real = await fs.realpath(file),
            base = await fs.realpath(root);
          if (!real.startsWith(base + path.sep))
            return new Response("Forbidden", { status: 403 });
          return net.fetch(pathToFileURL(real).href);
        } catch {
          return new Response("Not found", { status: 404 });
        }
      });
      win = new BrowserWindow({
        title: "文青尚品",
        width: 1440,
        height: 1000,
        minWidth: 1024,
        minHeight: 740,
        show: false,
        backgroundColor: "#f6f8fb",
        titleBarStyle:
          process.platform === "darwin" ? "hiddenInset" : "default",
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
        },
      });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event, url) => {
        if (url !== APP_URL) event.preventDefault();
      });
      win.webContents.session.setPermissionRequestHandler(
        (_web, _permission, callback) => callback(false),
      );
      ipcMain.handle("wqapp:call", async (event, req) => {
        try {
          if (
            event.sender !== win.webContents ||
            event.senderFrame !== win.webContents.mainFrame ||
            event.senderFrame.url !== APP_URL
          )
            throw Error("拒绝非本机应用页面调用");
          if (!req || typeof req.op !== "string") throw Error("请求无效");
          return { ok: true, result: await handle(req.op, req.payload) };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      });
      service.on("state", sendState);
      win.on("close", (event) => {
        if (service.running) {
          event.preventDefault();
          void dialog
            .showMessageBox(win, {
              type: "question",
              message: "当前批次尚未结束",
              detail:
                "可以留在后台，或完成当前商品后停止并退出。不会关闭店铺浏览器。",
              buttons: ["留在后台", "完成当前商品后退出"],
              defaultId: 0,
              cancelId: 0,
            })
            .then(async (r) => {
              if (r.response === 1) {
                exitAfterCurrent = true;
                await service.stopAfterCurrent();
              }
              win.hide();
            });
        }
      });
      win.once("ready-to-show", () => win.show());
      await win.loadURL(APP_URL);
      void (async () => {
        await service.refreshShops();
        if (service.config.materialsRoot) await service.scan();
      })().catch((e) => {
        service.scanErrors = [
          { folder: service.config.materialsRoot, error: e.message },
        ];
        sendState();
      });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "文青尚品",
            submenu: [
              { role: "about" },
              { role: "hide" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
          {
            label: "编辑",
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            ],
          },
          {
            label: "窗口",
            submenu: [
              { role: "minimize" },
              { role: "zoom" },
              { role: "front" },
            ],
          },
        ]),
      );
    })
    .catch((e) => {
      dialog.showErrorBox("文青尚品启动失败", e.message);
      app.quit();
    });
  app.on("activate", () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
  app.on("before-quit", (e) => {
    if (service?.running) {
      e.preventDefault();
      if (win) win.close();
    }
  });
  app.on("window-all-closed", () => app.quit());
}
