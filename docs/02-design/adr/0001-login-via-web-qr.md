# ADR-0001 · 登录路线：网页扫码，不碰桌面端凭据

- 状态: **部分被推翻** —— 见 [ADR-0008](./0008-desktop-credential-reuse.md)
- 日期: 2026-11-06
- 决策者: 项目所有者
- 相关: [02-prior-raccoon-plugins](../01-research/02-prior-raccoon-plugins.md)、[E-006](../01-research/05-empirical-findings.md)、[E-030](../01-research/05-empirical-findings.md)

> **⚠️ 过期说明（2026-11-06 追加）**
> 本 ADR 的核心前提"桌面端凭据在本机不存在（E-006）"**是错的**：E-006 只查了 `~/.box-agent/config/auth.json`，而 Windows 桌面端实际把凭据写在 `~/.office-raccoon/agent/config/auth.json`（E-030），那个文件一直存在且 token 可用（E-031）。
> 因此"不碰桌面端凭据"这条约束已被 [ADR-0008](./0008-desktop-credential-reuse.md) 取代：桌面端凭据现在是**首选**来源，扫码是兜底。
> 本 ADR 中仍然成立的部分：**不读浏览器 cookie 库、不碰 Windows 凭据管理器、不捞进程内存**这三条边界没有变，也被 ADR-0008 原样继承。

---

## 背景

要接小浣熊，得先有凭据。已有的六份实现里出现过两条路：

**路线 A：读桌面端凭据**

`dsh-raccoon-connect@0.2.4`：

```js
const AUTH_FILE = path.join(os.homedir(), ".box-agent", "config", "auth.json");
```

读 `~/.box-agent/config/auth.json`，里面有桌面客户端登录后的 token。

**路线 B：网页微信扫码**

`dsh-llm-adapters@1.2.4` 与 `magpie-raccoon-auth@0.3.2`：

```
POST /api/iam/v1/auth/mp/qrcode      → 拿二维码
POST /api/iam/v1/auth/mp/qrcode/login → 轮询
POST /api/web/auth/v1/iam/confirm     → 换 xhx_token
```

---

## 本机实测

```bash
ls -l ~/.box-agent/config/auth.json
```

```
No such file or directory
```

```bash
ls -d ~/AppData/Local/Programs/*raccoon*
```

```
No such file or directory
```

存在的痕迹：

```
~/AppData/Roaming/office-raccoon/desktop-device-identity.json
{"schemaVersion":1,"clientDeviceId":"0bbdf36a-97d9-4e31-a354-855cf4103c52","createdAt":"2026-11-04T05:33:50.627Z"}
```

**只有 `clientDeviceId`（UUID + 创建时间），没有 token。**

路线 B 实测可用：

```bash
curl -sS -X POST https://xiaohuanxiong.com/api/iam/v1/auth/mp/qrcode -H 'content-type: application/json' -d '{}'
```

```json
{"code":"OK","data":{"expires_in":300,"poll_interval":2,
 "qrcode_code":"qr-01a1ae79-...","scan_path":"/login/mp","status":"pending"}}
```

---

## 决策

**只走路线 B（网页扫码）。不实现路线 A。**

具体地：

1. 不读 `~/.box-agent/config/auth.json`
2. 不读 `~/AppData/Roaming/office-raccoon/` 下的任何文件
3. 不读系统浏览器的 cookie 库（Chrome/Edge 的 `Cookies` SQLite）
4. 不读 Windows 凭据管理器
5. 不尝试从 `office-raccoon` 的进程内存里捞

---

## 理由

### 1. 路线 A 在本机不存在

不是"难"，是**入口没了**。桌面端要么没装，要么把凭据挪去了别的地方。为一个不存在的文件写兼容层，是纯浪费。

### 2. 路线 A 的可用性不受我们控制

`dsh-raccoon-connect` 死在这一点上：桌面端一改存储位置，插件就废。
即使我们写十条兜底路径，下一次改动又会全废。

**网页扫码的入口是服务端契约**，只要小浣熊官网还用微信登录，它就成立。

### 3. 读桌面端凭据越过了用户的授权范围

用户装这个插件时想的是"帮我把小浣熊接进 DSH"。

他没想的是"随便翻我的 AppData"。

`office-raccoon` 的目录里可能有别的东西（日志、缓存、对话记录）。一旦开了"读别的 app 的目录"这个口子，边界就模糊了。

**扫码是用户主动、可见、可控的动作。读文件不是。**

### 4. 读浏览器 cookie 库是明确越界

Chrome 的 `Cookies` 是 SQLite，加密密钥在 `Local State` 里（Windows 上还用 DPAPI）。技术上能读（`ego_login_import` 就在做类似的事，但那是**用户显式要求**的）。

一个"小浣熊反代插件"去解密用户全部浏览器的 cookie，是明显的权限扩张。不做。

### 5. 扫码带来了更好的失败模式

| | 路线 A | 路线 B |
| --- | --- | --- |
| 凭据失效 | 静默失败，用户不知道为什么 | 二维码过期 → 提示"刷新" |
| 首次使用 | 必须先装桌面端并登录 | 手机扫一下 |
| 排障 | "读不到文件" | "码过期了 / 没扫 / 网络抖动" |

---

## 后果

### 正面

- 不依赖本机任何第三方 app
- 用户全程可见（自己扫码）
- 失败原因可枚举（pending / logging / success / canceled / expired）
- 换了电脑、重装系统，只要手机在就能用

### 负面

| 代价 | 缓解 |
| --- | --- |
| **必须用手机** | 无解。这是微信扫码的固有属性。但小浣熊官网本身也只支持微信登录 |
| **token 有效期有限**（`expires_in` 7200 秒量级） | 持久化 + 过期前静默校验；失效时明确提示重扫，不静默重试 |
| **无法无人值守部署**（服务器上跑 DSH 就扫不了） | 明确不支持。文档里写清楚 |

### 中性

- 我们拿不到"设备指纹"，所以 `x-client-platform` 只能声明自己是 `desktop-windows`。这是**声明**不是**伪造** —— 我们确实是一个桌面客户端。

---

## 替代方案（已考虑并否决）

| 方案 | 否决理由 |
| --- | --- |
| 读 `~/.box-agent/config/auth.json` | 文件不存在（E-006）；且上游一改就废 |
| 读浏览器 cookie | 权限扩张；Windows 上是 DPAPI 加密，要额外依赖 |
| 复制 `office-raccoon` 的登录态 | 同上；且它自己可能都没登录 |
| 让用户手动粘贴 token | 用户拿不到 —— token 在 httpOnly cookie 里 |
| 用自己的服务端做 OAuth 中转 | 引入一个需要长期维护的服务器；且用户凭据会经过第三方 |

---

## 复审条件

若出现以下任一情况，重新评估：

1. 小浣熊开放官方 OAuth / API Key 申请
2. 官方提供"设备码"流程（像 GitHub CLI 那样，不需要手机）
3. 微信扫码接口被下线

第 3 条如果发生，插件直接失效 —— 届时的正确做法是**停止维护**，而不是回头去挖浏览器 cookie。
