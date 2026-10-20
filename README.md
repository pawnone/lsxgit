# 文青尚品：软件规划与界面 Demo

- **本地 APP 页面**：双击 `demo/desktop.html`，可以切换 macOS / Windows 窗口外观。
- **网页页面**：双击 `demo/index.html`，使用相同的商品、店铺和任务逻辑。
- 两个入口都不需要安装依赖。桌面窗口控制仅演示外观；这不是 Electron 安装包。
- `软件规划方案.md`：软件选型、平台能力差异、店铺多选与任务矩阵、实施顺序。
- `screenshots/`：最新网页与桌面 APP 实际渲染截图。
- `检查结果.md`、`demo-check.json`：本地交互检查，不是真实上架验收。

可体验：同平台店铺多选、逐店登录与核对、未就绪阻断、商品勾选、目录交互、商品预览、开始前完整任务清单、冻结任务、串行预演、暂停/继续、安全停止、历史快照与报告导出。

默认仅勾选一家店。想预演两店时，主动勾选“青青臻选好物1号仓”，先点该店“核对店铺”，确认模拟核对，再检查本批素材。2件商品×2家店铺会列出4个草稿任务。第三家示例店未登录，可以演示登录后仍需核对的过程。

**所有登录、核对、检查和进度均为演示。** 原型不读取真实Excel内容、不连接店铺、不上传商品、不创建真实草稿。没有修改现有上架脚本、skill、商品资料或分发包。拼多多仍只有资料检查预览，浏览器执行未开放。

使用现有测试素材图片，Lucide图标许可证随 `demo/assets/icons/LICENSE` 保存。

## 开发与版本控制

仓库：https://github.com/pawnone/lsxgit ，分支 `master`。当前版本 `v0.2.0-demo`，属于交互原型。

需要 Node.js 22 或以上。Mac终端、Windows PowerShell均可运行：

```sh
git clone https://github.com/pawnone/lsxgit.git
cd lsxgit
npm ci
npm run dev
```

打开终端输出的地址，默认 `http://127.0.0.1:5173/` 展示桌面APP外观；`/index.html` 展示网页入口。端口占用时通过环境变量 `PORT` 设置其他端口。可将 `HOST` 设为开发容器需要的监听地址，默认只监听本机。

本项目当前运行时只用Node内置模块提供静态Demo，不需要数据库、模型API、店铺账号或真实商品资料。`npm ci` 安装的是锁定的开发测试依赖。

```sh
npm run check
npm test
npm run build
```

`build` 仅生成 `dist/` 静态界面，不生成 `.app`、`.dmg` 或 `.exe`。尚未接入Electron壳或真实上架执行器。

UI检查需准备测试浏览器：

```sh
npm run setup:browser
npm run test:ui
```

Linux容器若缺浏览器系统依赖，可按Playwright环境要求安装；UI检查不会连接商家后台。已安装Chrome的开发电脑也可通过 `PW_CHANNEL=chrome` 使用本机Chrome进行无头测试。

代码结构：

```text
demo/             网页与桌面外观，含共享任务模型和本地资源
scripts/          静态开发服务、语法检查和静态构建
test/             任务矩阵、身份门禁、快照和服务测试
check-demo.mjs    离线UI交互检查
screenshots/      当前版本的界面截图
软件规划方案.md    能力边界与实施路线
```

提交前运行检查与测试；不提交 `node_modules`、`dist`、登录profile、Cookie、真实Excel、视频或执行回执。第三方许可与示例素材声明见 `THIRD_PARTY_NOTICES.md`。当前仓库不是开源许可授权，项目代码标为UNLICENSED。
