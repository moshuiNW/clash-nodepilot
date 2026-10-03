# ⚡ clash-nodepilot

Clash / Mihomo 节点测速与筛选工具。**本地网页界面**，实时进度、可排序可搜索的结果表格，一键筛选并导出可用节点配置。

替代 `clash-speedtest`，重点解决它的几个痛点：界面是终端表格、订阅拉取失败会写空结果覆盖好文件、测试过程黑盒不可控。

## 平台支持

| 平台 | 状态 | 启动 | 停止 |
|------|------|------|------|
| **Windows** | ✅ 正式支持 | `启动.cmd` / `run.ps1` | `停止.cmd` / `停止.ps1` |
| **Linux** | ✅ 正式支持 | `./start.sh` | `./stop.sh` |
| macOS | ⚠️ 未测试（代码路径保留，欢迎社区验证） | `node src/server.mjs --open` | `npm run stop` |

CI 在 `ubuntu-latest` 与 `windows-latest` 上跑后端测试；macOS 没有 CI 覆盖，故不作承诺。

---

## 快速开始

### Windows

双击 **`启动.cmd`**（或运行 `run.ps1`），浏览器会自动打开 `http://127.0.0.1:8765`。

```powershell
node src\server.mjs              # 启动服务
node src\server.mjs --open       # 启动并打开浏览器
.\run.ps1 -Port 9000             # 指定端口
.\run.ps1 -CorePath "D:\mihomo\mihomo.exe"   # 指定内核
```

### Linux

```bash
./start.sh                   # 启动并自动打开浏览器
./start.sh --no-open         # 仅启动服务
./start.sh --port 9000       # 指定端口
./start.sh --core /usr/bin/mihomo   # 指定内核
```

首次运行会自动安装依赖（只装一个运行时依赖 `js-yaml`，且**不会**动 `node_modules` 里的其他包）。

> 需要 Node.js 18+。若端口被占用，`start.sh` 会直接提示改用 `NODEPILOT_PORT=9000 ./start.sh`。

**Linux 上内核从哪来？** 本工具不下载任何内核，只探测本机已有的 mihomo：

- Fedora / RHEL：`sudo dnf install clash-meta`（会装到 `/usr/bin/mihomo`）
- Arch / AUR：`mihomo`、`mihomo-bin` 等包
- Clash Verge Rev：其 `.deb` / `.rpm` 自带 `/usr/bin/verge-mihomo`
- 手动安装：把官方 release 解包后放到 `/usr/local/bin/mihomo` 或 `~/.local/bin/mihomo`

> 手动下载后**必须** `chmod +x`（`curl -O` 与解压都不一定保留可执行位）。若忘了，界面会直接提示 `修复: chmod +x <路径>`。

然后在页面里：

1. 粘贴订阅链接或本地配置路径 → 点 **读取节点**
2. 点 **开始测速**
3. 设置筛选条件 → **预览配置** / **保存到文件** / **下载 YAML**

---

## ⚠️ 怎么结束运行（重要）

**直接关闭网页标签 ≠ 结束运行。** 网页只是界面；后台还有一个 `node` 服务，以及它拉起的 **mihomo 内核**。只关网页的话这两个进程会继续在后台占用内存和端口。

三种结束方式，任选其一：

| 方式 | 操作 | 说明 |
|------|------|------|
| **① 界面按钮**（推荐） | 点右上角 **⏻** → 确认退出 | 会停掉测速、关闭 node 与 mihomo 内核，页面变成「已结束运行」 |
| **② 终端** | 在启动它的窗口按 **Ctrl+C** | 同样会一并停止内核 |
| **③ 停止脚本** | Windows 双击 `停止.cmd`；Linux 执行 `./stop.sh` | 网页已关、终端找不到时的兜底方案 |

命令行等价写法：

```powershell
# Windows
npm run stop                 # 请求关闭（走 HTTP 接口）
.\停止.ps1                   # 同上，且会确认端口是否释放
.\停止.ps1 -Force            # HTTP 不通时，直接结束进程
```

```bash
# Linux
npm run stop                 # 请求关闭（走 HTTP 接口）
./stop.sh                    # 同上，且会确认端口是否释放
./stop.sh --force            # HTTP 不通时，按 PID / 工作目录兜底结束
```

停止脚本只会结束本工具的进程，**不会动你自己的 Clash Verge 内核**。识别依据是本工具独有的工作目录（记录在 PID 文件里），你的 Verge 内核用不同的工作目录启动，因此不会命中。

> 小提示：**只是想暂时不用**，直接关掉网页标签就行——后台进程会继续运行，重新打开 http://127.0.0.1:8765 即可继续；只有确实不再需要时才用上面的方式彻底停掉。

---

## 它是怎么工作的

关键设计：**不重新实现任何代理协议**，而是复用 mihomo 内核做数据面。

```
订阅 / 配置文件
      │  解析出节点列表
      ▼
   mihomo 内核（自动探测本机已有内核）
      │  每个节点分配一个本地 mixed 监听端口
      │  listeners: [{ port: 20001, proxy: "香港 01" }, ...]
      ▼
  测速引擎  ──►  127.0.0.1:20001  ══CONNECT══►  香港 01
            ──►  127.0.0.1:20002  ══CONNECT══►  日本 01     （并行）
            ──►  127.0.0.1:20003  ══CONNECT══►  新加坡 01
```

mihomo 的 `listeners` 支持 `proxy: <节点名>`，把某个入站端口的流量**强制绑定到指定节点**。所以一个内核实例就能同时暴露几十个"专属端口"，每个端口 = 一个节点，可以真正并行测速。

参考：[mihomo 入站配置文档](https://github.com/MetaCubeX/Meta-Docs/blob/main/docs/config/inbound/index.md)

### 内核自动探测

按顺序查找本机已有的 mihomo / clash-meta 内核，**找不到才需要你手动指定**：

- 环境变量 `NODEPILOT_CORE` / `NODEPILOT_CORE_DIR`
- 工具目录及其 `bin/`、`core/` 子目录
- **Windows**：`Clash Verge` 安装目录、`%LOCALAPPDATA%\Programs`、`%APPDATA%`、scoop apps 等
- **Linux**：`/usr/local/bin`、`/usr/bin`、`/opt/mihomo`、`~/.local/bin`、`~/bin`、
  `$XDG_DATA_HOME/io.github.clash-verge-rev.clash-verge-rev`
  （不含 Flatpak/Snap/AppImage 路径：Clash Verge Rev 只发布 `.deb` / `.rpm`）
- 系统的 `PATH`

同名文件会优先选**稳定版**而不是 `-alpha` 版本。

找不到内核时，界面会区分「没找到」与「找到了但跑不起来」，后者会直接给出修复方式。
最常见的 Linux 情况是手动下载的内核缺少可执行位，此时提示 `修复: chmod +x <路径>`。

---

## 测速指标

| 指标 | 含义 |
|------|------|
| **延迟** | TTFB（首字节时间）。多次取样取**中位数**，越低越好 |
| **抖动** | 延迟样本的标准差，越低说明线路越稳 |
| **丢包** | 探测失败比例。单次失败会自动重试一次，避免把偶发抖动误报成丢包 |
| **下载速度** | 传输窗口内的实测吞吐（**不含**连接握手时间） |
| **解锁** | 各流媒体 / AI 服务的可用性（可选，见下） |

### 精度上的几个刻意选择

这些都是实测踩坑后修正的，直接影响数据可信度：

1. **延迟预热**：第一个请求要付 DNS + TCP/TLS 握手 + 节点建连成本。若计入，会把抖动算得极大、甚至误判丢包。所以先发一个**丢弃的预热请求**。
2. **吞吐量排除握手**：下载速度按 `首个数据字节 → 结束` 的窗口计算，而不是整个请求耗时。否则延迟高的节点会被系统性低估。
3. **并发不要调太高**：本机内核在高并发下会成为瓶颈，**凭空制造丢包**。实测同一批节点：并发 1 时丢包 6%，并发 8 时"丢包"19%。默认值已按实测校准（延迟并发 4）。
4. **204 响应**：`generate_204` 返回**没有响应体**，所以 TTFB 在响应头到达时就记录，而不是等第一个数据块。

### 默认测速地址

按实测吞吐排序，失败自动降级到下一个：

| 地址 | 实测 | 说明 |
|------|------|------|
| `dl.google.com/.../googlechrome.dmg` | 20 MB/s | 最快，但会 **302 跳转**（已自动跟随） |
| `speed.cloudflare.com/__down?bytes=26214400` | 10 MB/s | 稳定；**注意 >25MiB 会返回 403** |
| `mirror.nju.edu.cn/ubuntu/ls-lR.gz` | 13 MB/s | 国内镜像，支持 Range |
| `download.thinkbroadband.com/100MB.zip` | 2 MB/s | 备选 |

> 已排除的坑：`cachefly.cachefly.net/100mb.test` 并不是 100MB 文件（只返回 25 字节的说明文本）；`speedtest.tokyo.linode.com` 已失效。

上传测速默认关闭（`speed.cloudflare.com/__up` 实测可用，但建议数据量 ≥10MiB，否则单请求开销占主导）。

---

## 流媒体解锁检测

在「高级设置」里勾选**启用流媒体解锁检测**即可。默认检测：

ChatGPT · Claude · Gemini · YouTube Premium · Netflix · Disney+ · Spotify · TikTok · Prime Video · OpenAI API · 哔哩哔哩港澳台

结果以彩色标签显示在表格**解锁**列，绿色=已解锁、红色删除线=被封锁、灰色=检测失败/未知。鼠标悬停可看出口地区和失败原因。也可以：按解锁状态筛选表格、只导出「必须解锁某服务」的节点。

### 为什么不能用 HTTP 状态码判断

实测发现：**这些服务在被封锁的地区同样返回 200**。用状态码判断会得出"全部解锁"的错误结论。因此每个服务用各自的真实信号：

| 信号类型 | 例子 |
|----------|------|
| Cloudflare `loc=XX` 真实出口地区 | ChatGPT → `loc=SG`；Claude → `loc=TW` |
| 跳转路径里的地区 | Netflix → `/hk-en/...`；Spotify → `/us/`、`/sg-en/` |
| 页面里的封锁文案 | YouTube Premium → `not available in your country` |
| 接口返回码 | 哔哩哔哩港澳台 → `"code":0` 可播 / `-10403` 地区受限 |

### 踩过的坑（都会导致错误结论）

- **哔哩哔哩的 `ep_id` 必须真实有效**。用了一个不存在的 `ep_id` 时接口返回 `-404 啥都木有`，结果**所有节点都被误判为"被封锁"**。现在用的是实测可播的 `ep_id=98603`（HK/JP/SG 返回 0，US 返回 -10403，真正体现港澳台版权区）。
- **Spotify 的 `/region` 接口会 302 跳到地区路径**，跳转后是正常页面。早期用"页面找不到"文案判断，造成大量假阴性。
- **`gemini.google.com` 响应头超过 Node 默认 16KB 上限**，会报 `Header overflow`。已把 `maxHeaderSize` 提高到 128KB。

---

## 界面功能

- **实时进度**：SSE 推送，节点一测完就上屏，不用等全部结束
- **排序 / 搜索 / 筛选**：点表头排序，按名称搜索，按状态过滤
- **速度条形图**：表格内直观对比
- **深色 / 浅色主题**：右上角切换，记住选择
- **运行日志**：可查看应用日志与内核日志
- **导出**：
  - 按地区+速度重命名（如 `🇭🇰 HK 001 | ⬇️ 10.29MB/s`）
  - 保留原配置的 DNS / TUN / 规则
  - 生成自动选择 / 故障转移组
  - 可只导出表格中勾选的节点

---

## 相比旧工具修复的问题

| 旧工具的问题 | 现在的行为 |
|--------------|------------|
| 订阅拉取失败仍写出空 `result.yaml`，**覆盖掉上次的好结果** | 拉取失败直接报错，**不写任何文件**；写文件走临时文件 + 原子重命名，且校验内容含 `proxies:` 段 |
| 导出的配置**规则指向已不存在的策略组**，粘进 Clash Verge 会加载失败 | 导出时重写规则里的策略目标，并**用真实 mihomo 内核校验**过（见下） |
| 终端表格，观感陈旧 | 本地网页 UI，实时刷新、可排序可搜索 |
| 停止测速按钮无效 | 已修复（abort 用错了对象） |
| 部分节点测完后永远停在中间状态 | 已修复：收尾时把所有非终态节点都归位 |
| 没有退出方式，关网页后后台进程仍在跑 | 新增界面 ⏻ 按钮 + `停止.cmd` / `npm run stop` |
| （自身早期版本）启动脚本会删掉 `node_modules` 里的测试依赖 | 已修复：只按需安装 `js-yaml`，不再触碰其他包 |
| 测试过程黑盒 | 实时进度 + 阶段提示 + 完整日志 |
| 筛选参数只能敲命令行 | 图形化筛选，导出前可预览 |
| 单次探测失败即记为丢包 | 自动重试一次，减少误报 |
| 没有解锁检测 | 内置 11 个服务的解锁检测，可筛选、可导出 |

### 导出配置经过真实内核校验

导出的 YAML **不只是"看起来对"**，而是用 mihomo 自己的配置检查跑过：

```bash
# 工具内部逻辑等价于：
mihomo -d <dir> -t      # -> "configuration file ... test is successful"
```

这一步抓出过一个真实 bug：原订阅的规则形如 `IP-CIDR,91.108.4.0/22,闪电猫,no-resolve`——策略**不在最后一个字段**。早期版本用"最后一个逗号"定位策略，会把规则改坏，导致 mihomo 报 `proxy [闪电猫] not found` 而整个配置加载失败。现在按规则类型定位策略字段，并正确处理 `AND/OR/NOT` 这类含括号逗号的逻辑规则。

---

## 测试

```bash
npm test          # 规则重写 + 导出安全 + 真实内核校验（自带启停服务，可独立运行）
npm run test:ui   # 无头浏览器跑完整界面流程（需 npx playwright install chromium）
npm run test:all  # 全部
```

**测试默认不消耗订阅流量**：不设置环境变量时使用 `tests/fixtures/` 里的占位节点（域名不存在、连不通），依赖真实连通的用例会自动 SKIP 并说明原因。

### ⚠️ 用真实节点测试前请先读

测速是真的在下载数据。一轮「每节点 6 秒 × 15MB/s」≈ **每节点 90MB**，28 个节点就是 **2.5GB 左右**。所以测试**务必限制节点数**：

```powershell
# Windows
$env:NODEPILOT_TEST_SUB   = "D:\path\to\config.yaml"   # 或订阅 URL
$env:NODEPILOT_TEST_LIMIT = "3"                        # 节点数上限（默认 3）
npm run test:ui
```

```bash
# Linux
NODEPILOT_TEST_SUB=/path/to/config.yaml NODEPILOT_TEST_LIMIT=3 npm run test:ui
```

界面里也有对应的 **「只读取前 N 个节点」** 输入框。日常手动测速同样建议先限量确认效果，再决定要不要全量跑。

| 测试 | 覆盖内容 |
|------|----------|
| `tests/core-finder.test.mjs` | 内核探测：Linux 路径清单、EACCES/ENOENT 提示、**垃圾文件不得被误认为内核** |
| `tests/proc.test.mjs` | 进程识别：`isOurCore` 的正反例（别的 workDir / 已死 PID / 自身 PID 均不命中） |
| `tests/ruletest.test.mjs` | 14 条规则改写用例，含 `no-resolve` 后缀与 `AND/OR/NOT` 逻辑规则 |
| `tests/safety.test.mjs` | 11 项：订阅失败 / 筛选为空时**绝不覆盖**已有结果文件 |
| `tests/validate.test.mjs` | 用真实 mihomo `-t` 校验导出配置确实能加载 |
| `tests/uitest.test.mjs` | 真实浏览器：加载订阅 → 测速 → 表格渲染 → 导出预览 |
| `tests/unlock-ui.test.mjs` | 解锁检测全流程：勾选服务 → 检测 → 标签渲染 → 按解锁筛选/导出 |
| `tests/unlock-chips.test.mjs` | 校验表格里每个解锁标签的颜色与后端数据**逐条一致**（防止界面说谎） |
| `tests/shutdown.test.mjs` | 关闭后 **node 与 mihomo 内核都必须退出**、端口释放、且不影响你自己的 Clash Verge（按平台分派：Linux 走 `/proc`，Windows 走 CIM） |
| `tests/quit-ui.test.mjs` | 界面退出按钮：确认框 → 取消不退出 → 确认后后端真的停止 |

全部用例通过后才是可发布状态。

### Linux 冒烟测试（真实订阅）

`tools/smoke-linux.sh` 在真实订阅上验证「拉取 → 分配端口 → 内核就绪 → 延时 → 极短下载」整条链路：

```bash
NODEPILOT_SMOKE_SUB="<订阅链接>" ./tools/smoke-linux.sh
NODEPILOT_SMOKE_SUB="<订阅链接>" NODEPILOT_SMOKE_DOWNLOAD=0 ./tools/smoke-linux.sh   # 只测延时
```

流量刻意压到最小：先用 `maxLatencyMs=1` 使下载候选集为空、只收延时数据（每个节点一次 204 探测），
再以实测最短延时为阈值，只对**最快那 1 个节点**做 2 秒下载。
订阅链接只从 `NODEPILOT_SMOKE_SUB` 读取，未设置时脚本直接跳过（退出码 0），因此可以安全放进 CI。

---

## 项目结构

```
clash-nodepilot/
├── 启动.cmd                 # Windows 双击启动
├── 停止.cmd                 # Windows 双击停止（关网页后也能用）
├── run.ps1                  # PowerShell 启动脚本
├── 停止.ps1                 # PowerShell 停止脚本
├── start.sh                 # Linux 启动脚本
├── stop.sh                  # Linux 停止脚本
├── .github/workflows/ci.yml # ubuntu + windows 双平台跑后端测试
├── tools/
│   └── smoke-linux.sh       # Linux 真实订阅冒烟（流量已最小化）
├── package.json
├── tests/                   # 见上方「测试」
└── src/
    ├── server.mjs           # HTTP 服务 + JSON API + SSE
    ├── core/
    │   ├── core-finder.mjs   # 探测本机 mihomo 内核（区分「没有」与「不可执行」）
    │   ├── core-manager.mjs  # 生成配置、托管内核、分配端口
    │   ├── proc.mjs          # 跨平台进程识别 / PID 文件
    │   ├── stop.mjs          # 三层停止逻辑（HTTP → PID → 工作目录扫描）
    │   ├── subscription.mjs  # 订阅拉取与解析（含 proxy-providers）
    │   ├── tunnel.mjs        # CONNECT 隧道 + 计时/计速（零依赖）
    │   ├── engine.mjs        # 测速流程编排
    │   ├── unlock.mjs        # 流媒体解锁检测
    │   ├── exporter.mjs      # 筛选、重命名、生成配置
    │   └── util.mjs
    └── public/               # 前端（原生 JS，无构建步骤）
        ├── index.html
        ├── styles.css
        └── app.js
```

依赖：**仅 `js-yaml`**。前端零依赖、零构建。

---

## 环境变量

| 变量 | 说明 |
|------|------|
| `NODEPILOT_PORT` | 服务端口（默认 8765） |
| `NODEPILOT_CORE` | 直接指定内核路径 |
| `NODEPILOT_CORE_DIR` | 额外搜索内核的目录 |
| `NODEPILOT_SMOKE_SUB` | `tools/smoke-linux.sh` 用的订阅地址（未设置则跳过冒烟） |
| `NODEPILOT_SMOKE_NODES` | 冒烟时读取的节点数上限（默认 3） |
| `NODEPILOT_SMOKE_DOWNLOAD` | 设为 `0` 时冒烟只测延时、完全不下载 |
| `NODEPILOT_TEST_SUB` / `NODEPILOT_TEST_LIMIT` | UI 测试用的订阅与节点上限 |

---

## 变更说明

### 1.1.0

- **Linux 正式支持**：新增 `start.sh` / `stop.sh`，内核探测补齐 Linux 真实安装路径，
  找不到时区分「没有内核」与「有但不可执行」并提示 `chmod +x`
- 新增跨平台进程层：停止时按 HTTP → PID 文件 → 工作目录扫描三层处理，并显式验证 PID，
  确保只结束本工具的进程
- `shutdown` 测试改为平台分派（此前在 Linux 会因调用 PowerShell 而崩掉整个测试套件），
  新增内核探测与进程识别单测
- 新增 CI：`ubuntu-latest` + `windows-latest` 跑后端测试
- 新增 `tools/smoke-linux.sh` 真实订阅冒烟脚本

### 1.0.0

- 首个版本：Clash / Mihomo 节点测速与筛选，本地 Web UI

---

## 注意事项

- 测速会占用真实带宽，注意流量。
- 若同时运行 Clash Verge 等代理软件，**TUN 模式可能接管系统流量**，影响"直连"类参考值（但不影响经节点端口的测量）。
- 测速端点在中国大陆的可达性会随时间变化，可在「高级设置」里换成你信任的地址。
- Linux 上本工具**不会**下载任何内核；请自行安装 mihomo（见上方「Linux」一节）。

## License

GPL-3.0（与 mihomo 生态保持一致）
