# 开发环境

最后更新: 2026-11-06（按实现回填）
状态: 已定稿

> 一句话：**内核包只能从 DSH 安装目录解析，热更靠改 `cordis.patch.yml` 里的 `name`，其余都是普通 Node 24 + tsup。**

---

## 1. 本机实测环境（E-013）

| 项 | 值 |
| --- | --- |
| OS | Windows 10/11 x64 |
| Node（PATH 上） | v24.22.1 |
| Node（DSH 运行时内） | v24.21.0（`resources/app/runtime/versions.json`） |
| npm | 12.2.0 |
| pnpm | 12.14.0 |
| DSH | 0.2.1-rc.5（`@deepseek-ai/dsh-desktop-runtime`） |
| DSH 安装目录 | `C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh` |
| DSH 用户目录 | `C:\Users\Administrator\.dsh` |
| profile | `~/.dsh/profiles/desktop` |
| Python（只用于 QR 验证） | 3.12.14 + `cv2 5.0.0` + `PIL 12.2.0` |
| 工作区 | `D:\dsh小浣熊反代开发`（**路径含中文，这会影响两处，见 §3**） |

---

## 2. 目录关系（必须搞清楚）

```
C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh\
├── package.json                 @deepseek-ai/dsh-desktop-runtime 0.2.1-rc.5
├── desktop-runtime.json         194 个包的清单
└── node_modules\@deepseek-ai\   全套内核包都在这里（**只能从这里解析**）
    ├── dsh-llm\
    ├── dsh-llm-pi-ai\
    ├── dsh-settings\
    ├── dsh-client-modules\
    └── ...
    node_modules\@earendil-works\pi-ai\     v1.1.0

C:\Users\Administrator\.dsh\
├── .credentials.yaml
├── cordis.patch.yml             顶层，内容 `[]`
├── plugins\                     只有 dsh-purge 的 tgz
├── profiles\
│   ├── node_modules\@deepseek-ai\  **悬空符号链接**（指向一个已不存在的源码树）
│   └── desktop\
│       ├── package.json         dsh-profile-desktop，dependencies 里链着本插件
│       ├── cordis.yml           内容 `[]`（注释说明树由 bundles + patch 组合）
│       ├── cordis.patch.yml     **热更要改这里**
│       ├── settings-legacy.yaml 插件设置持久化在这
│       └── node_modules\dsh-raccoon-web  →  junction 到工作区
└── state\dsh-raccoon-web\       token.json / vision-probe.json
```

**工作区**：

```
D:\dsh小浣熊反代开发\
├── packages\dsh-raccoon-web\    插件本体
│   ├── src\protocol\  src\provider\  src\host\
│   ├── client.js                手写 classic script（不经 tsup）
│   └── lib\index.js  lib\client.js   构建产物
├── node_modules\@deepseek-ai\dsh-llm       → junction 到安装目录（冒烟脚本用）
├── node_modules\@deepseek-ai\dsh-llm-pi-ai → junction
├── node_modules\@earendil-works\pi-ai      → junction
└── scripts\  docs\  devlog\  research\
```

---

## 3. 五个必须知道的坑

### 3.1 从 profile 里 import 不到内核包

`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm` 是**悬空的符号链接**（指向 `C:/Users/Administrator/WorkBuddy/2026-08-14-08-41-09/.../dsh-llm`，那个目录早没了）。从 `~/.dsh/profiles/desktop` 跑 `import("@deepseek-ai/dsh-llm")` → `ERR_MODULE_NOT_FOUND`。

修法（E-008）：内核包只能从**安装目录**解析。工作区里为此建了三条 junction（`node_modules/@deepseek-ai/dsh-llm`、`dsh-llm-pi-ai`、`node_modules/@earendil-works/pi-ai`），这样冒烟脚本能真实 import。`.gitignore` 已忽略 `node_modules`。

### 3.2 内核包没有 `.d.ts`

所有 `@deepseek-ai/dsh-*` 包 `find -name '*.d.ts'` 的结果都是 0，但 `package.json.types` 仍然指向 `lib/types/index.d.ts`。**类型提示必断**，所以本项目手写 `src/types/dsh.d.ts` 补桩（E-009）。

写桩时值必须照抄实现，不能猜。踩过的例子：
- `RetryPolicy.mode` 只能是 `"normal" | "always"`（`dsh-llm/lib/index.js:247-347` 的 switch 只认这两个），不是 `"aggressive" | "never"`。
- `AdapterRegistrationHandle.replace(providers: string[]): void` —— 参数是 string 数组、返回 void（见 §3.4）。

### 3.3 tsup 的 `onSuccess` 在中文路径下必然失败

`onSuccess: "node ../../scripts/copy-client.mjs"` 在 `D:\dsh小浣熊反代开发` 下报 `The system cannot find the path specified.` 并让 tsup 非零退出（产物其实已生成）。原因是 tsup 用 shell 拼命令行，`cmd.exe` 按 cp936 解释中文路径（E-026）。

**修法**：不写 `onSuccess`，改 `packages/dsh-raccoon-web/package.json` 的 `"build": "tsup && node ../../scripts/copy-client.mjs"`。

### 3.4 `lib/index.js` 改了**不会**热更，`lib/client.js` 改了**会**

- 宿主半身：进程启动时按 `cordis.patch.yml` 里的 `name` 解析一次。直接覆盖 `lib/index.js` 没有任何效果；`touch cordis.patch.yml` 也不行。
- **热更办法**：把那条 insert 的 `name` 从裸包名改成**带版本查询串的绝对 `file://` URL**，几秒内宿主就重新 import。这是 `dshmarket/lib/hot.js` 的 `hotMount()` 自己在用的做法。
- 浏览器半身：`dsh-client-modules` 的 combo 路由是 `/plugins/??<包名>/client.js&rev=<rev>`，`rev` 由 `mtime/ctime/size` 算出（`artifactRevision()`）。`lib/client.js` 变了 `rev` 就变，宿主会下发新的 —— **只要刷新页面**。

两个脚本把这件事固定下来：

```bash
node scripts/link.mjs          # 写 file:///D:/.../lib/index.js?v=<mtime>（幂等，已最新则跳过）
npm run revive -- --tag sm1   # 手动换 tag，强制宿主重载
npm run revive -- --dry       # 只看会改成什么
npm run revive -- --restore   # 恢复成裸包名（调试 loader 问题时用）
```

### 3.5 `~/.dsh/logs` 里没有当前实例的日志

`~/.dsh/logs/desktop-next.log` 最后写于 2026-11-03，当前运行的实例不往那里写。**排障走 HTTP status 端点，不要翻日志。**

而且 `curl http://127.0.0.1:57292/` 会返回 401 `dsh web authentication required; reopen the URL printed by dsh web.` —— web launch token 是进程启动时随机生成、只经命令行 URL 传出的，**从磁盘找不回来**。插件自己的 `/plugins/<name>/status` 端点不受这个限制（loopback 即可）。

---

## 4. 第一次配置

```powershell
# 1. 进工作区
cd D:\dsh小浣熊反代开发

# 2. 装开发依赖（只有 tsup + typescript）
npm install

# 3. 确认能从安装目录解析内核包
cd "C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh"
node -e "import('@deepseek-ai/dsh-llm').then(m=>console.log('ok', Object.keys(m).length))"
node -e "import('@earendil-works/pi-ai').then(m=>console.log('ok', Object.keys(m).length))"

# 4. 回到工作区，建三条 junction（只需一次）
cd D:\dsh小浣熊反代开发
#   node_modules\@deepseek-ai\dsh-llm      → 安装目录同名包
#   node_modules\@deepseek-ai\dsh-llm-pi-ai → 安装目录同名包
#   node_modules\@earendil-works\pi-ai     → 安装目录同名包

# 5. 构建
npm run build

# 6. 链进 profile（写 file URL，等于顺便支持热更）
node scripts/link.mjs

# 7. 验证
node scripts/verify-install.mjs
curl.exe "http://127.0.0.1:57292/plugins/dsh-raccoon-web/status"
```

### 为什么开发依赖只有两个

`tsup`（打包）+ `typescript`（类型检查）。**不装**：

- `@types/node` —— Node 24 已内置大部分，缺的用 `src/types` 补
- 测试框架 —— 用 `node --test`（配一个 30 行的 ESM loader 钩子做 import 重写）
- linter —— 文件小 + 约定明确，lint 收益低于维护成本
- prettier —— 同上

依赖越少，"三周后回来还能装得上"的概率越高。

---

## 5. 日常循环

```powershell
# 改宿主半身（src/**）
npm run build              # tsup ~1 秒 + 复制 client.js
npm run revive             # 让运行中的 DSH 重新 import（5 秒内生效）

# 改浏览器半身（client.js）
npm run build              # 只复制 + 静态检查
# 浏览器 Ctrl+Shift+R，然后在 console 敲：
#   __DSH_BUILD_raccoon     ← 应该等于 src/build.ts 里的 BUILD

# 跑测试
npm test                   # 168 个用例，~0.4 秒
npm run typecheck
npm run smoke              # 宿主半身 + provider 装配（不碰网络）
npm run smoke:live         # 桌面端凭据 → 真网关（需要已登录客户端）
npm run smoke:chat         # 真对话（会花少量积分）
```

**什么时候需要重启 DSH**：只有在改插件集合本身（`package.json` 的 `dsh.profile.bundles`、增删 `cordis.patch.yml` 的条目）时。改代码不需要。

### 快速确认插件是否加载

```powershell
# 1. 接口侧（最快，200 就说明宿主半身活着）
curl.exe "http://127.0.0.1:57292/plugins/dsh-raccoon-web/status"

# 2. 看构建时间戳对不对
curl.exe -s "http://127.0.0.1:57292/plugins/dsh-raccoon-web/status" | Select-String build

# 3. 浏览器侧（F12 Console）
__DSH_BUILD_raccoon

# 4. 客户端脚本是否被下发（combo 路由，注意 ?? 与 &rev=）
#    rev 由 lib/client.js 的 mtime/ctime/size 算出，12 位 hex
curl.exe "http://127.0.0.1:57292/plugins/??dsh-raccoon-web/client.js&rev=<rev>"
```

---

## 6. 调试三件套

### 6.1 直接打网关（不经过 DSH）

```powershell
node scripts/probe-gateway.mjs
# 输出：
#   POST /api/iam/v1/auth/mp/qrcode        200  code=qr-... expires=300
#   GET  /api/web/llm/v2/model_catalog     401  200001 authorization_empty_error
#   GET  /api/web/points/v1/balance        401  200001

node scripts/probe-gateway.mjs --token <token>   # 带真 token 跑全套
node scripts/probe-gateway.mjs --from-profile    # 从 state/dsh-raccoon-web/token.json 读
```

改动协议代码**之前**先跑这个。网关变了不是代码有 bug，是假设过期了 —— 先更新 `docs/01-research/05-empirical-findings.md`，再改代码。

### 6.2 看桌面端凭据读到了没有

```powershell
node --experimental-strip-types --import ./scripts/ts-resolve-register.mjs -e "import('./packages/dsh-raccoon-web/src/protocol/desktop-auth.ts').then(async m => { const a = await m.readDesktopAuth(); console.log(a === undefined ? '未读到' : { source: a.source, principal: a.principal, expiresAt: new Date(a.expiresAt).toISOString(), len: a.token.length }); })"
```

只要打印出 `principal` 与 `expiresAt` 就说明路径对。**不要打印 token 本身。**

### 6.3 二维码真解码

```powershell
# 从运行中的宿主取码 → 还原矩阵 → 落 PNG
node scripts/login-qr.mjs --new --out research/captures/qr.png

# 批量容量边界验证（需要 python + cv2）
node --experimental-strip-types --import ./scripts/ts-resolve-register.mjs scripts/verify-qr.mjs
```

`verify-qr.mjs` 同时用 `cv2.QRCodeDetector` 与 `cv2.QRCodeDetectorAruco` 解码并比对原文。**只用其中一个检测器会误判**：真宿主下发的 57×57 符号，`QRCodeDetector` 返回 0 字节，`QRCodeDetectorAruco` 正常（E-024）。另外读图要用 `cv2.imdecode(np.fromfile(path))`，`cv2.imread` 在含中文的路径上会 `can't open/read`。

---

## 7. 常见环境问题

| 症状 | 原因 | 处置 |
| --- | --- | --- |
| `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-llm` | 从 profile 目录跑的 | 从安装目录跑，或建 §4 的第 4 步 junction |
| `tsup` 退出码非 0 但产物存在 | `onSuccess` 在中文路径下失败 | 见 §3.3，把复制挪到 `package.json` 的 build 脚本里 |
| `pnpm install` 报 `ERR_PNPM_IGNORED_BUILDS` | `esbuild` / `protobufjs` 的 postinstall 被拦 | 包已落盘，构建照常可用；要消掉就在 `pnpm-workspace.yaml` 加 `onlyBuiltDependencies: [esbuild]` |
| 改了代码宿主没反应 | `lib/index.js` 不热更 | `npm run build && npm run revive` |
| `curl` 根路径 401 | web launch token 只在命令行 URL 里 | 用 `/plugins/<name>/status`（loopback 放行） |
| `refresh-auth` 报 `providers is not iterable` | 内核 `replace()` 返回 void 且换不掉 adapter | 已修：改成「先释放再注册」（CHANGELOG「修复」段） |
| `Provider is not configured: raccoon-web` | `auth.apiKey.resolve()` 返回 undefined | 已修（同上） |
| client.js 改了浏览器没变 | 页面缓存 | Ctrl+Shift+R，并用 `__DSH_BUILD_raccoon` 确认 |

---

## 8. 不要做的事

1. **不要在 profile 里 `npm install` 装内核包。** 会让 `node_modules` 里多出一份版本不同的 kernel，行为诡异。
2. **不要 `git commit` `research/pkgs/`。** 那是别人的包，只读参考。
3. **不要手改 `~/.dsh/profiles/desktop/package.json` 的 `dependencies`** —— 用 `scripts/link.mjs` / `unlink.mjs`，它们幂等且会同时处理 bundles / patch / junction。
4. **不要把 token 贴进 issue 或日志。** 日志只打 `sha256` 前 8 位。
5. **不要删 `~/.office-raccoon/agent/config/auth.json`** —— 那是官方客户端的登录态，删了等于把用户从小浣熊客户端里登出。
