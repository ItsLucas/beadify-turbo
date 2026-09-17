# beadify-turbo · 拼豆工作台

基于 [Jett-Wu/Perler_Beads_Generator](https://github.com/Jett-Wu/Perler_Beads_Generator) 的改进 fork，起点为 [`36ac52d`](https://github.com/Jett-Wu/Perler_Beads_Generator/commit/36ac52d570246ab600611a79edd2236bccb954e5)，保留上游 Git 历史与 MIT [LICENSE](LICENSE)。感谢上游提供编辑器、图层、画笔、3D 预览和色卡基础。

把图片转换为可编辑、可打印的拼豆图纸。图像采样、结构优化、手工标注和导出均在浏览器完成；服务器只托管网页，原图与项目保存在你的设备上。

[在线使用](https://itslucas.github.io/beadify-turbo/) · [改进内容](docs/improvements.md) · [详细使用教程](docs/user-guide.md) · [部署教程](docs/lite-deployment.md) · [下载 0.5.1](https://github.com/ItsLucas/beadify-turbo/releases/tag/v0.5.1) · [使用与素材权利说明](USAGE_RIGHTS.md)

![Beadify Turbo 工作台，使用本仓库原创合成样例](docs/images/workbench.png)

## 我们 Turbo 了什么

- **生成更可控：** Worker 与 CLI 共用 CPU 核心；生成进度、取消和过期任务保护；先比较候选，接受后新增图层，一次撤销恢复。
- **主体与细节：** 裁切、边界去背景、保留/删除画笔、外围白边裁切；主导色与结构优化、多网格位置比较、跨色细线/部件形状/关键颜色证据。
- **局部重算：** 锁住选区外图纸，设置颜色、空格、细节与色数约束；有原图缓存时支持从原图重算。
- **保存与导出：** 修复旧 cells 项目恢复，保存色卡快照、主体设置和结构缓存；PNG/SVG/分页 PDF、CSV/JSON BOM、Excel 按最终可见图纸统一计数。
- **手工文字处理：** 区域/笔画标注、记录导入导出、原字形增强和按原区域重新排字。
- **便于部署：** 独立静态包、SHA-256 校验、systemd/Nginx 模板；无需 Python、数据库或 GPU。

221/291 色卡及基础编辑能力来自上游；本 fork 增加了完整色数设置和新核心约束。逐项对照及质量边界见 [改进说明](docs/improvements.md)。

## 快速部署

直接打开 [GitHub Pages 工作台](https://itslucas.github.io/beadify-turbo/) 即可使用，无需安装。`main` 更新后由 GitHub Actions 自动构建并发布。

只需运行时可在 [Releases](https://github.com/ItsLucas/beadify-turbo/releases/tag/v0.5.1) 下载 `beadify-turbo-lite-0.5.1.tar.gz` 和同名 `.sha256`，放在同一目录：

```sh
sha256sum -c beadify-turbo-lite-0.5.1.tar.gz.sha256
tar -xzf beadify-turbo-lite-0.5.1.tar.gz
node web-lite/serve.cjs
```

打开 `http://服务器IP:8080`。Node 方式需要 **Node.js 22+**，不需要 `npm install`。也可将整个 `web-lite/` 目录交给 Nginx，此时部署机器连 Node 都不需要。包约 1.3 MiB，小规模静态托管可从 1 vCPU / 512 MiB RAM 起步；计算主要消耗访问者设备资源。详细安装、HTTPS/路径说明、常驻服务、性能口径与更新步骤见 [部署教程](docs/lite-deployment.md)。

从源码运行：

```sh
git clone https://github.com/ItsLucas/beadify-turbo.git
cd beadify-turbo
npm ci --ignore-scripts
npm run dev
```

打开 `http://127.0.0.1:5174`。默认监听 `0.0.0.0`；仅本机访问可运行 `BEADIFY_HOST=127.0.0.1 npm run dev`。`npm run dev` 会构建后启动；已有构建用 `npm run preview`。源码修改后重新构建并刷新。

```sh
npm run package:lite
# 兼容的打包命令
npm run package:web
```

产物是 `generated/web-lite/` 和 `generated/beadify-turbo-lite-0.5.1.tar.gz`。必须通过 HTTP(S) 访问，不能双击 HTML 使用 Worker。

## 使用

1. 上传 PNG/JPEG/WebP，在主体编辑器拖框裁切。白底图可选择边界去背景，用保留/删除画笔修正眼白、尾巴、链条等区域。
   外围白边可单独点击“裁切白色边框”：只收紧外侧整行/整列白边，框内背景与白色高光保留，支持容差和撤销。
2. 设置图纸宽高与色数。基础色卡上限为 221 色，可直接输入或点击“使用全部221色”；切换完整色卡后支持 291 色。该值是可用色数上限，实际用色由图片和算法决定。默认保留原版算法；可切换主导色采样、结构优化、面积或最近邻。原图比例会保留，空余位置透明。
3. 接受候选后显示新图层，旧图层保留并隐藏；可一次撤销。画笔、填充、擦除等原有编辑工具继续可用。
4. 结构采样可点“比较网格位置”，查看中心及上下左右五个候选。可在“标记原图细节”框出部件，填写可接受色号和最少保留格数，再用结构优化生成。
5. “选区重算与保护”中拖框，设置颜色/空格锁、保护细节、简化或特征色。有原图缓存时可选“原图细节重算”，也可“整理当前图纸”；两者都锁定选区外格子。缓存随项目保存，缺原图仍能复用生成时的结构信息；重新裁切或重新采样须选择原文件。
6. 导出项目 JSON 保存图层、色卡快照、原图设置、结构缓存、文字分析/手工校正和约束。文字分析也可单独导入导出；按原图 RGBA 内容校验，换图后不会错用旧记录。原图文件不嵌入项目；再次选择同一原文件可恢复主体设置，新文件通过内容 hash 区分。容量不足时先保全图纸和编辑内容，先省略可重建的原图细节记录；仍不足时省略文字分析并提示单独导出，当前标注保留在内存。基础文档也无法保存时提示导出 JSON。
7. PNG/SVG/PDF、CSV/JSON BOM、Excel 与右侧用量都按最终可见图纸计数。隐藏层不计数，重叠位置只取最上层可见豆子。PDF 支持 A4/Letter、分页重叠、镜像和毫米间距；打印时选择100%，核对50毫米校准尺。

结构与细节改进用于“结构优化”，保持硬色数上限。旧项目仍能打开；重新选择原图可建立新的线条和形状证据。

重算规则约束算法，不限制手工画笔；手动改色后可重新设置锁。色卡限制与锁定冲突会报错，需提高色数、放开颜色或调整规则。

图片 ≤20 MiB / 4 MP / 单边4096；解码前先检查图片头尺寸。目标单边 ≤256格。工作台支持 MARD 基础221色及完整291色，RGB是上游近似值，不是实体测量值。已有像素画可选择像素原图模式，绕过去纹理。

## 验证

```sh
npm test
npm run typecheck
npm run build
npx playwright install chromium
npm run test:e2e
npm run test:lite
```

Linux/Windows 的 CPU 工作流见 [CI](.github/workflows/ci.yml)。可用 `BEADIFY_CHROMIUM=/path/to/chrome` 指定已有浏览器。测试覆盖候选、撤销、主体处理、文字编辑、项目恢复及图纸导出。

## 使用边界

请使用你拥有权利、得到许可或依法可使用的图片。将图片转换成拼豆图纸不自动获得原作品的版权或商业使用许可；分享图纸、出售成品前需自行确认相应权利。代码的 MIT 许可不覆盖第三方图片、角色、标识、字体或实体色卡数据。详见 [素材权利说明](USAGE_RIGHTS.md) 和 [第三方通知](THIRD_PARTY_NOTICES)。

仓库不提供第三方作品素材库；私人照片及派生结果不进入 Git。项目保存在浏览器中，重要作品请导出项目 JSON，迁移域名/端口前先备份。

结构优化尚无独立人评证明普遍优于原版，因此保持原版算法为默认。弯曲细线、斜线、眼内留白和复杂文字仍可能失真；真实照片 holdout、其它浏览器/设备及实际打印、实体制作仍需补验。MARD RGB 沿用上游近似值，不是实体测量或品牌认证值。
