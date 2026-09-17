# Beadify Turbo 轻量部署

## GitHub Pages

在线地址：**https://itslucas.github.io/beadify-turbo/**。无需安装，直接在浏览器制图；更换设备或站点前请导出项目 JSON。

本仓库已配置 [Pages 工作流](../.github/workflows/pages.yml)：`main` 更新后自动构建、检查项目子路径下的生成和导出，再发布网页。也可在 Actions 中选择 **Publish GitHub Pages → Run workflow** 手动更新。

部署到自己的 fork 时，在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**，再运行该工作流。默认网址为 `https://用户名.github.io/仓库名/`。构建产物仅通过 Pages 部署，不提交到源码分支。

图案生成、优化、画布与导出在访问者浏览器运行，服务器只提供网页和 Worker 脚本。无需数据库、Python 或 GPU；图片和项目不上传到随包服务器。项目保存在浏览器，切换域名/端口前请导出项目 JSON。

部署包保留主体裁切、手工去背景、细节标记、颜色约束、图层和撤销、手工文字标注与重排，以及项目和 PNG/SVG/PDF/BOM 导出。采用预压缩 gzip、流式输出和 ETag 缓存校验。

产物目录是 `generated/web-lite/`，压缩包为 `generated/beadify-turbo-lite-0.5.1.tar.gz`，另附 SHA-256 校验文件。[功能改进](improvements.md) · [详细使用教程](user-guide.md)

## 获取和构建

从 [GitHub Release v0.5.1](https://github.com/ItsLucas/beadify-turbo/releases/tag/v0.5.1) 下载以下两个文件到同一目录：

- [部署压缩包](https://github.com/ItsLucas/beadify-turbo/releases/download/v0.5.1/beadify-turbo-lite-0.5.1.tar.gz)
- [SHA-256 校验](https://github.com/ItsLucas/beadify-turbo/releases/download/v0.5.1/beadify-turbo-lite-0.5.1.tar.gz.sha256)

或者在开发机构建：

```sh
git clone https://github.com/ItsLucas/beadify-turbo.git
cd beadify-turbo
npm ci --ignore-scripts
npm run package:lite
```

`npm run package:web` 是同一打包入口的兼容别名。`npm run build` 也生成轻量包；`npm run dev` 构建后在 5174 启动，`npm run preview` 使用已有构建。

构建机需要 Node.js 22+、npm 和 `tar`；Windows 可用现代 Windows 自带的 tar，在 PowerShell 使用同样的 npm 命令。部署机器直接使用产物，不必安装开发依赖。包约 **1.28 MiB**，展开文件内容约 **3.59 MiB**（包含 gzip 副本，另有 manifest 和文件系统开销）；保留 20–50 MiB 应用空间足够放当前包、旧包和展开目录，操作系统/Node 本身另计。

## Node 独立运行

目标机器已有 Node.js 22+ 时：

```sh
sha256sum -c beadify-turbo-lite-0.5.1.tar.gz.sha256
tar -xzf beadify-turbo-lite-0.5.1.tar.gz
node web-lite/serve.cjs
```

访问 `http://服务器IP:8080`。自定义端口用 `node web-lite/serve.cjs 8081`；`BEADIFY_HOST` 指定监听地址。服务只读部署目录，不需要可写数据目录，也不需要 npm install。不能直接用 file:// 双击 HTML，需 HTTP(S) 承载模块与 Worker。

Windows PowerShell 可用 `Get-FileHash .\beadify-turbo-lite-0.5.1.tar.gz -Algorithm SHA256`，将结果与 `.sha256` 文件内容核对后解压；`tar -xzf` 和 `node web-lite/serve.cjs` 命令相同。Node 不在 PATH 时应使用其实际安装路径。

Linux systemd 模板在包内 `beadify-turbo.service`，默认安装路径 `/opt/beadify-turbo`、Node 路径 `/usr/bin/node`、端口 8080：

```sh
sudo install -d -m 755 /opt/beadify-turbo
sudo cp -a web-lite/. /opt/beadify-turbo/
sudo chmod -R a+rX /opt/beadify-turbo
sudo install -m 644 web-lite/beadify-turbo.service /etc/systemd/system/beadify-turbo.service
sudo systemctl daemon-reload
sudo systemctl enable --now beadify-turbo.service
systemctl status beadify-turbo.service
```

模板使用 DynamicUser、只读系统保护和 256 MiB 服务内存上限，无 GPU 补充组。按目标机修改路径/端口；模板需在目标机用 `systemd-analyze verify` 检查。服务部署模板与源码预览的端口不同。

## 已有静态服务器时

也可把整个目录交给 Nginx 或其它静态 HTTP 服务器，此时部署端连 Node.js 都不需要。附带的 `nginx.conf` 使用 `/opt/beadify-turbo`、8080 端口，拒绝 `/api/`，提供正确 MIME 和 gzip；将 server 块合入已有配置后先 `nginx -t` 再重载。静态托管方式见 [Nginx 官方说明](https://nginx.org/en/docs/beginners_guide.html#static)，gzip 配置见 [官方模块文档](https://nginx.org/en/docs/http/ngx_http_gzip_module.html)。

两种启动方式任选其一，不要让它们同时占用同一端口。Nginx 模板在本机未执行，因为本机未安装 Nginx；下方性能数值来自随包 Node 服务。Node 直接发送预压缩文件，Nginx 示例用动态 gzip，两者 CPU 开销不能视为完全相同。

## 静态托管路径与 HTTPS

保留 `src/`、`vendor/`、许可证和 manifest 的相对结构。网页可以部署到站点根路径，也支持 Pages 的 `/beadify-turbo/` 项目路径；子路径入口应以 `/` 结尾。域名和 HTTPS 由 Pages、Nginx 或静态托管平台配置。网页与 Worker 必须同源，反向代理只需转发静态 GET/HEAD 请求。

## 配置与升级

小规模静态托管可从 1 vCPU / 512 MiB RAM 起步，1 GiB RAM 更有余量；无需数据库。首次打开受服务器带宽影响，图片计算主要使用访问者设备的 CPU 和内存。较慢的设备可先用较小原图、40–50 格或面积采样，再尝试结构优化。

升级前导出重要项目 JSON，保留旧部署目录。下载新包并核对校验值，替换目录后重启静态服务并刷新浏览器。回退时恢复旧目录；旧版本不一定能读取新增格式的项目。

源码更新可用 `git pull --ff-only`、`npm ci --ignore-scripts`、`npm run package:lite`。验证构建产物用 `npm run test:lite`，首次需要 `npx playwright install chromium`。部署产物、日志和性能记录保存在本地，不纳入源码仓库。
