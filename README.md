# 文青尚品

本机桌面 APP，使用已有抖店 Playwright 执行器读取本机 Excel 和素材，逐店、逐商品保存草稿。运行不依赖 Workbuddy、Codex、模型接口或系统 Node.js。

当前版本 **v0.3.0-alpha**：macOS Apple 芯片本机测试版。已接入抖店；拼多多保留入口，尚未开放执行。当前抖店适配范围为 **服装 > 女装 > 时尚套装、5张主图、现货预售混合**，不能据此推定支持其他类目、Windows 或所有后台改版。

## 直接使用 Mac APP

1. 打开 `文青尚品.app`。本机需已安装 Google Chrome，无需填写端口。
2. 添加后台显示的完整店名，点击“登录”，在专用 Chrome 中人工登录。每店使用独立资料目录；APP不会复制其他浏览器的 Cookie。
3. 回到 APP 点击该店“核对”。页面实际店名必须精确一致，不能用“浏览器已打开”代替核对成功。
4. 点击“选择文件夹”，选择总素材库。一级子文件夹各代表一个商品，读取其中的 `商品信息/商品信息.xlsx` 和素材目录。错误显示到商品、字段或路径，不猜填。
5. 勾选店铺和商品，检查本批素材，确认完整的商品 × 店铺任务清单，再开始。新增店铺不会默认全选。
6. 在运行记录查看结果。只有取得保存成功证据才标为“已保存草稿”。

**仅保存草稿，不提供正式发布。** 验证码、安全限制或权限拒绝会停止整批并保留 Chrome；人工处理后需重新核对。APP不解验证码，不伪装浏览器，不自动绕过或恢复。暂停、停止和正常退出以当前商品为边界，避免在保存中途杀进程。

已有确认草稿会跳过，跳过不算本次新保存。保存结果未知会阻断；不要删回执、更换任务目录或重复点开始。崩溃重启会将中断任务标为待核实，保留原始记录。

Excel 中商家编码由用户提供，原样保留，不自动生成。价格只读现有统一售价及个别尺码调整；组合件数、年龄、风格及“对应主图编号”继续使用原字段。没有另造一套 APP 商品模板。

## 数据存放

APP配置、运行记录和每店浏览器资料在 macOS 用户的应用数据目录（`~/Library/Application Support/文青尚品/`），素材留在你选择的原目录。换电脑需重新选择本机素材库、添加店铺并登录，不复制 Cookie。

- `config.json`：路径、店铺与勾选项；每次打开重新核对登录状态。
- `tasks/`：按店铺ID、商品ID、内容版本固定的保存意图和原始回执。
- `runs/`：不可随当前选择改变的批次快照与日志。
- `browser-profiles/`：独立 Chrome 登录资料。关闭 APP 不关闭这些浏览器。

本机依赖 Chrome 和正常平台访问；去掉智能体调度不会让网络上传自动变快。首版本机包仅做开发签名，未做外部分发签名、公证和自动更新，不是已验收的 Windows 安装包。

## 开发与检查

仓库：https://github.com/pawnone/lsxgit 。源码开发需 Node.js 22.12 或以上。

```sh
npm ci
npm start
npm run check
npm test
npm run test:native
npm run build:mac
```

`npm start` / `npm run app` 打开真实 Electron APP；`build:mac` 使用当前 Mac 架构生成 `release/文青尚品-darwin-arm64/文青尚品.app`（Apple芯片）。运行产物已包含 Electron 的 Node 运行时及生产依赖。

`npm run test:native` 使用临时、独立的测试数据目录验证实际原生 APP，无真实店铺写入。可通过 `WQ_TEST_APP` 指向打包后的可执行文件，通过 `WQ_TEST_MATERIALS` 指向本机素材库增加只读 Excel/图片检查；不把这些本机路径写进项目配置。`node scripts/check-safety.mjs` 仅在本地模拟页面验证安全停止和浏览器保留。

早期外观 Demo 仍保留：`npm run demo` 启动网页，`npm run build:demo` 生成静态文件；`npm run test:ui` 检查模拟交互。Demo不是实际执行入口，不能将其模拟结果当作真实草稿回执。

```text
desktop/            Electron主进程、隔离preload、任务服务、原生页面与worker
engine/doudian/     既有0.2.17执行器的集成快照及来源哈希
scripts/            打包、语法、原生APP及本地安全检查
test/               多店队列、身份/资料/安全门禁、恢复与重复保护测试
demo/               早期交互原型及共享图标/样式
```

检查结果与限制见 `APP检查记录.md`；版本见 `CHANGELOG.md`。不提交密码、Cookie、登录资料、真实 Excel、视频、回执或本机配置。第三方许可见 `THIRD_PARTY_NOTICES.md`。
