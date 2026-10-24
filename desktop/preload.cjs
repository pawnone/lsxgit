const { contextBridge, ipcRenderer } = require("electron");
const invoke = async (op, payload = {}) => {
  const r = await ipcRenderer.invoke("wqapp:call", { op, payload });
  if (!r.ok) throw new Error(r.error);
  return r.result;
};
contextBridge.exposeInMainWorld("wqapp", {
  getState: () => invoke("state"),
  exportPddTemplate: type => invoke('export-pdd-template',{type}),
  chooseRoot: () => invoke("choose-root"),
  openMaterial: (id) => invoke("open-material",{id}),
  scan: () => invoke("scan"),
  setPlatform: (platform) => invoke("set-platform", {platform}),
  mainImageNames: (id, token) => invoke("main-image-names", {id,token}),
  imageSettings: (id,token,selection) => invoke('image-settings',{id,token,selection}),
  numberPddImages: id => invoke('number-pdd-images',{id}),
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
