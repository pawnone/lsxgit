import { packager } from "@electron/packager";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
);
if (process.platform !== "darwin") throw Error("此构建任务需在Mac上运行");
const out = await packager({
  dir: root,
  out: path.join(root, "release"),
  name: "文青尚品",
  icon: path.join(root, "desktop/assets/app-icon.icns"),
  osxSign: {
    identity: "-",
    identityValidation: false,
    continueOnError: false,
    optionsForFile: () => ({
      hardenedRuntime: false,
      entitlements: path.join(
        root,
        "desktop/assets/development-entitlements.plist",
      ),
    }),
  },
  platform: "darwin",
  arch: process.arch,
  electronVersion: pkg.devDependencies.electron,
  appBundleId: "com.wenqing.shangpin",
  appVersion: pkg.version,
  buildVersion: pkg.version.split("-")[0],
  overwrite: true,
  prune: true,
  asar: false,
  ignore: [
    /^\/\.git(?:\/|$)/,
    /^\/(?:test|scripts|screenshots|dist|release|output|\.native-test-data)(?:\/|$)/,
    /^\/check-demo\.mjs$/,
    /^\/demo-check\.json$/,
  ],
});
console.log("Mac APP生成：" + out.join("\n"));
