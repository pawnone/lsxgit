const { contextBridge, ipcRenderer } = require("electron");
const invoke = async (op, payload = {}) => {
  const r = await ipcRenderer.invoke("wqapp:call", { op, payload });
  if (!r.ok) throw new Error(r.error);
  return r.result;
};
contextBridge.exposeInMainWorld("wqapp", {
  getState: () => invoke("state"),
  chooseRoot: () => invoke("choose-root"),
  scan: () => invoke("scan"),
  addShop: (name, platform) => invoke("add-shop", { name, platform }),
  select: (selection) => invoke("select", selection),
  openLogin: (id) => invoke("open-login", { id }),
  newLogin: (id) => invoke("open-login", { id, fresh: true }),
  refreshShops: () => invoke("refresh-shops"),
  verifyShop: (id, acknowledgeSafety = false) =>
    invoke("verify", { id, acknowledgeSafety }),
  check: (mode = "normal") => invoke("check", { mode }),
  start: (token) => invoke("start", { token }),
  pause: () => invoke("pause"),
  resume: () => invoke("resume"),
  stopAfterCurrent: () => invoke("stop"),
  openReport: (id) => invoke("open-report", { id }),
  exportReport: (id) => invoke("export-report", { id }),
  onState: (fn) => {
    const handler = (_event, data) => fn(data);
    ipcRenderer.on("wqapp:state", handler);
    return () => ipcRenderer.removeListener("wqapp:state", handler);
  },
});
