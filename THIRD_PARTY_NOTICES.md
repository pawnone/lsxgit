# 第三方与示例资源

- Electron 44.9.1，https://github.com/electron/electron ，MIT。桌面运行时；Chromium等附带第三方声明随APP内LICENSE及LICENSES.chromium.html分发。
- Microsoft Playwright Core 1.64.0，https://github.com/microsoft/playwright ，Apache-2.0。原生检查及实际抖店浏览器执行，使用官方API。
- ExcelJS 4.4.0，https://github.com/exceljs/exceljs ，MIT。读取用户已有Excel；生产依赖许可证保留在APP的node_modules中。
- @electron/packager 20.3.0，https://github.com/electron/packager ，BSD-2-Clause。开发打包工具，不作为生产依赖打入APP。
- `desktop/assets/app-icon.svg`和对应icns衍生自同一Lucide layers图标，保留ISC/MIT来源声明。
- `demo/assets/icons/`：Lucide 0.468.0官方SVG，ISC；其中衍生自Feather的部分保留MIT版权声明，完整许可证见该目录的LICENSE。
- `engine/doudian/`：本工作区已有抖店0.2.17执行器的集成快照。来源文件哈希和集成改动见UPSTREAM.json；未引入不明“绕风控”项目。
- 演示商品图仅用于界面示例，保留原素材权利；不受上述组件许可证覆盖。
- 本项目代码尚未授予额外开源许可证，package.json标为UNLICENSED。公开仓库不自动改变原素材及第三方组件的许可。

实现前检查了上述官方来源、许可证和与现有Node执行器的兼容性；锁定版本由package-lock.json管理。Electron与Packager已确认官方仓库维护中；本次在macOS arm64真实构建并检查，不据此声称Windows已通过。
