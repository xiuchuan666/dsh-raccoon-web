"use strict";
/**
 * 浏览器半身：输入框旁的积分药丸 + 插件页上的设置卡。
 *
 * ## 这是一个 classic script，不是模块
 *
 * 宿主把这个文件当普通 `<script>` 加载，然后调 `window.__ModuleLoader__.load`
 * 把工厂函数交给它。所以这里：
 *
 * - **不能有 `import` / `export`**（脚本作用域里出现就是语法错误，整个插件静默失效）
 * - **不能有 JSX**（没有编译步骤，写 JSX 就是语法错误）
 * - React 从宿主那里 `require('react')` 拿，不自己打包一份
 *
 * 三条都犯过 —— 见 docs/04-ops/01-troubleshooting.md §2。
 *
 * ## 两个界面，一个 store
 *
 * 药丸和设置卡读同一份数据。共享 store 的意义是"一次轮询喂两个界面"，
 * 而不是"两个界面各poll一次"—— 后者会让 status 端点被请求两次，
 * 而那个端点会触发上游余额查询（有配额成本）。
 *
 * 轮询间隔是**动态**的：登录中 1.5s（要看二维码状态变化），
 * 平时 20s。用 setTimeout 链而不是 setInterval，因为间隔要跟着状态变。
 *
 * ## token 永远不在这里
 *
 * status 端点不返回 token，这个文件也从不请求 token。它只能看到
 * "已登录 / 未登录 / 账号前 8 位"。见 docs/02-design/00-architecture.md。
 */

(function bootstrapRaccoonClient() {
    var BUNDLE_NAME = 'dsh-raccoon-web';
    var NAMESPACE = 'dsh-raccoon-web';
    var STATUS_PATH = '/plugins/dsh-raccoon-web/status';
    var ACTION_PATH = '/plugins/dsh-raccoon-web/action';

    /**
     * 构建标记。必须与宿主 src/build.ts 的 BUILD 一致 ——
     * 不一致就说明浏览器加载的是缓存的旧脚本。
     */
    var BUILD = '2026-11-12T02:05';

    /** provider id。宿主用同一个值注册，这里只用来判断"当前选的是不是我"。 */
    var PROVIDER_ID = 'raccoon-web';

    var POLL_IDLE_MS = 20000;
    var POLL_LOGIN_MS = 1500;

    // ---------------------------------------------------------------- 文案

    var zh = {
        title: '小浣熊',
        pillLoading: '小浣熊 · 读取中',
        pillSignedOut: '小浣熊 · 未登录',
        pillDead: '小浣熊 · 登录已失效',
        pillQuota: '小浣熊 · {points} 积分',
        pillUnknown: '小浣熊',
        pillOtherModel: '这是小浣熊账号的余额，与当前选的模型无关；切换模型不会改变这个数字。',

        pageTitle: '小浣熊',
        pageSubtitle: '直接使用官方客户端已登录的账号，或扫码接入 xiaohuanxiong.com。凭据只在本机读取，插件不代持、不共享、不上传。',

        loginTitle: '登录',
        loginReady: '已登录',
        loginNone: '未登录',
        loginPending: '等待扫码',
        loginLogging: '已扫码，请在手机上确认',
        loginExpired: '二维码已过期',
        loginError: '登录失败',
        loginStart: '扫码登录',
        loginRestart: '重新获取二维码',
        loginCancel: '取消',
        loginOut: '退出登录',
        loginScanHint: '用微信扫描二维码，在手机上确认后这里会自动变成已登录。',
        loginPoolBusy: '正在为账号池添加账号 —— 二维码在下面的「账号池」区域，扫完不会改变当前账号。',
        loginLastPoll: '最近一次轮询：{value}',
        loginExpiresIn: '{seconds} 秒后失效',
        loginAccount: '账号',
        loginTokenKind: '令牌类型',
        loginTokenExpires: '令牌到期',
        loginNoExpiry: '无到期时间',
        loginSource: '来源',
        loginSourceDesktop: '官方客户端',
        loginSourceQr: '扫码',
        loginRefreshAuth: '读取客户端登录态',
        loginDesktopFound: '已读到官方客户端登录态',
        loginDesktopMissing: '未读到官方客户端的登录态：先在「商汤小浣熊」客户端里登录，或改用扫码。',
        loginDesktopExpired: '官方客户端的登录态已过期：打开客户端重新登录一次，或改用扫码。',
        loginDesktopReadonly: '这份凭据是官方客户端在维护的，插件只读。要真正退出，请到客户端里退出登录。',

        quotaTitle: '积分',
        quotaAvailable: '可用积分',
        quotaPermanent: '永久积分',
        quotaDaily: '每日积分',
        quotaGranted: '今日已到账',
        quotaNotGranted: '今日未到账',
        quotaGrantUnknown: '到账状态未知',
        quotaNote: '每日积分在当天首次打开小浣熊网页时发放，插件只读不代领。',
        quotaRefresh: '刷新',
        quotaStale: '更新于 {time}',

        modelsTitle: '模型',
        modelsEmpty: '还没有拉到模型目录。登录后会自动获取。',
        modelsCount: '{count} 个',
        modelsContext: '{tokens} 上下文',
        modelsVisionYes: '可读图',
        modelsVisionNo: '纯文本',
        modelsVisionProbed: '实测',
        modelsRefresh: '刷新目录',

        providerTitle: '接入状态',
        providerPublished: '已注册到模型选择器',
        providerDisabled: '已在设置里关闭',
        providerNotConfigured: '尚未登录，未注册',
        providerHint: '关闭后小浣熊会从模型选择器里消失，已选的会话也发不出去。',

        settingsTitle: '设置',
        settingAuthSource: '登录来源',
        settingAuthAuto: '自动（客户端优先）',
        settingAuthDesktop: '只用官方客户端',
        settingAuthQr: '只扫码',
        settingAuthHint: '自动：装了小浣熊客户端并已登录就直接用它，读不到再退回扫码。凭据只从本机文件读，不写回、不上传。',
        settingQrProtocol: '扫码协议',
        settingQrWeb: 'Web auth（官方客户端同款）',
        settingQrIam: 'IAM 小程序码',
        settingQrHint: 'Web auth：code 本地生成，不先请求服务端；官方桌面客户端用的就是这一种。IAM：需要先向服务端取码，是唯一能被微信小程序识别的一种。两种码互不通用。',
        settingEnabled: '启用小浣熊',
        settingReasoning: '允许思考',
        settingReasoningHint: '关闭后请求会带 thinking.type=disabled。部分模型即使这样仍会思考，那是上游行为。',
        settingCap: '上下文上限',
        settingCapHint: '上游按账号 token 速率限流，一轮对话上下文越大越快撞到上限。调小能撑更久。',
        settingDebug: '详细日志',
        settingDebugHint: '打开后宿主会记录每个请求的耗时与帧数。日志里不会有你的对话内容。',

        diagTitle: '诊断',
        diagCopy: '复制',
        diagCopied: '已复制',
        diagHint: '排障时把这段贴出来。它不含令牌。',

        buildLabel: 'build {build}',

        errNetwork: '连不上宿主进程。DSH 可能在重启。',
        errAction: '操作失败：{message}',
        probing: '探测中…',
        probeOk: '支持读图',
        probeNo: '不支持读图',
        probeUnknown: '看不出来',
        probeButton: '实测读图',
        probeHint: '用一张 3×3 纯红图片问颜色。目录里的识图标签实测会错，所以给一个手动核对的办法。',

        poolTitle: '账号池',
        poolHint: '每个账号有独立的设备标识，互不干扰。成员要显式勾选才会被拿去发请求。',
        poolEnabledLabel: '自动换号',
        poolEnabledHint: '打开后，一个账号额度用完或撞到限流就自动切到下一个。关掉只停止自动换号 —— 签到与测试仍然可用。',
        poolEmpty: '池里还没有账号。扫码添加，或直接导入官方客户端已登录的那个。',
        poolAddQr: '扫码添加',
        poolAddDesktop: '导入客户端账号',
        poolCheckin: '一键签到',
        poolCheckinBusy: '签到中…',
        poolTest: '测试',
        poolTesting: '测试中…',
        poolRemove: '移除',
        poolRemoveConfirm: '确认移除',
        poolStateUnknown: '未测',
        poolStateOk: '可用',
        poolStateLimited: '限流中',
        poolStateEmpty: '额度用尽',
        poolStateDead: '凭据失效',
        poolStateFlaky: '暂时不可用',
        poolActive: '当前使用',
        poolCount: '{total} 个账号 · {enabled} 个启用',
        poolDevice: '设备 {device}',
        poolExpires: '凭据 {time} 到期',
        poolCoolUntil: '冷却到 {time}',
        poolCheckinAlready: '今日已签',
        poolCheckinGranted: '已签到',
        poolCheckinFailed: '签到失败',
        poolAddHint: '新加进来的账号默认不启用，勾上才会被拿去发请求。',
        poolImportOk: '已导入客户端账号。',
        poolAddBrowser: '浏览器登录',
        poolAddBrowserBusy: '正在打开…',
        poolBrowserHint: '在浏览器里用手机号或微信登录，完成后浏览器会跳回本机，这个页面会自动出现新账号。官方客户端换账号用的就是这条路。',
        poolBrowserWaiting: '正在等待浏览器完成登录（最多 5 分钟）。',
        poolBrowserOpen: '打开授权页',
        poolBrowserCancel: '取消等待',
    };

    var en = {
        title: 'Raccoon',
        pillLoading: 'Raccoon · loading',
        pillSignedOut: 'Raccoon · signed out',
        pillDead: 'Raccoon · session expired',
        pillQuota: 'Raccoon · {points} points',
        pillUnknown: 'Raccoon',
        pillOtherModel: 'This is your Raccoon account balance; it does not depend on the model currently selected.',

        pageTitle: 'Raccoon',
        pageSubtitle: 'Uses the account already signed in on the official desktop app, or signs in to xiaohuanxiong.com by QR. Credentials are read on this machine only — never held, shared, or uploaded.',

        loginTitle: 'Sign in',
        loginReady: 'Signed in',
        loginNone: 'Not signed in',
        loginPending: 'Waiting for scan',
        loginLogging: 'Scanned — confirm on your phone',
        loginExpired: 'QR code expired',
        loginError: 'Sign-in failed',
        loginStart: 'Sign in by QR',
        loginRestart: 'Get a new QR code',
        loginCancel: 'Cancel',
        loginOut: 'Sign out',
        loginScanHint: 'Scan with WeChat and confirm on your phone. This page updates by itself.',
        loginPoolBusy: 'Adding an account to the pool — the QR code is in the Account pool section below. Scanning it will not change the current account.',
        loginLastPoll: 'Last poll: {value}',
        loginExpiresIn: 'expires in {seconds}s',
        loginAccount: 'Account',
        loginTokenKind: 'Token kind',
        loginTokenExpires: 'Token expires',
        loginNoExpiry: 'no expiry',
        loginSource: 'Source',
        loginSourceDesktop: 'desktop app',
        loginSourceQr: 'QR code',
        loginRefreshAuth: 'Read desktop sign-in',
        loginDesktopFound: 'Read the sign-in state of the official desktop app',
        loginDesktopMissing: 'No desktop sign-in found. Sign in to the Raccoon desktop app first, or use the QR code.',
        loginDesktopExpired: 'The desktop sign-in expired. Sign in again in the app, or use the QR code.',
        loginDesktopReadonly: 'The official desktop app owns this credential; the plugin only reads it. To really sign out, sign out in the app.',

        quotaTitle: 'Points',
        quotaAvailable: 'Available',
        quotaPermanent: 'Permanent',
        quotaDaily: 'Daily',
        quotaGranted: 'Granted today',
        quotaNotGranted: 'Not granted yet',
        quotaGrantUnknown: 'Grant status unknown',
        quotaNote: 'Daily points are granted when you first open the Raccoon website that day. The plugin only reads that state.',
        quotaRefresh: 'Refresh',
        quotaStale: 'updated {time}',

        modelsTitle: 'Models',
        modelsEmpty: 'No catalog yet. It loads after sign-in.',
        modelsCount: '{count} total',
        modelsContext: '{tokens} context',
        modelsVisionYes: 'vision',
        modelsVisionNo: 'text only',
        modelsVisionProbed: 'probed',
        modelsRefresh: 'Refresh catalog',

        providerTitle: 'Connection',
        providerPublished: 'Registered with the model picker',
        providerDisabled: 'Disabled in settings',
        providerNotConfigured: 'Not signed in — not registered',
        providerHint: 'When disabled, Raccoon disappears from the model picker and existing sessions cannot send.',

        settingsTitle: 'Settings',
        settingAuthSource: 'Sign-in source',
        settingAuthAuto: 'Auto (desktop first)',
        settingAuthDesktop: 'Desktop app only',
        settingAuthQr: 'QR only',
        settingAuthHint: 'Auto: if the Raccoon desktop app is installed and signed in, use it; otherwise fall back to QR. Credentials are read from a local file only — never written back or uploaded.',
        settingQrProtocol: 'QR protocol',
        settingQrWeb: 'Web auth (same as the desktop app)',
        settingQrIam: 'IAM mini-program code',
        settingQrHint: 'Web auth: the code is generated locally, no server round-trip — this is what the official desktop app uses. IAM: the code is issued by the server and is the only kind WeChat mini-program can recognise. The two are not interchangeable.',
        settingEnabled: 'Enable Raccoon',
        settingReasoning: 'Allow thinking',
        settingReasoningHint: 'When off, requests carry thinking.type=disabled. Some models think anyway; that is upstream behaviour.',
        settingCap: 'Context cap',
        settingCapHint: 'The account is rate-limited by token throughput, so a bigger context hits the wall sooner. Lower it to last longer.',
        settingDebug: 'Verbose logs',
        settingDebugHint: 'Records per-request timing and frame counts. Your conversation content is never logged.',

        diagTitle: 'Diagnostics',
        diagCopy: 'Copy',
        diagCopied: 'Copied',
        diagHint: 'Paste this when reporting a problem. It carries no token.',

        buildLabel: 'build {build}',

        errNetwork: 'Cannot reach the host process. DSH may be restarting.',
        errAction: 'Action failed: {message}',
        probing: 'Probing…',
        probeOk: 'Reads images',
        probeNo: 'Cannot read images',
        probeUnknown: 'Inconclusive',
        probeButton: 'Probe vision',
        probeHint: 'Asks a model to name the colour of a 3×3 solid red image. Catalog vision tags are known to be wrong, so there is a manual check.',

        poolTitle: 'Account pool',
        poolHint: 'Each account gets its own device identity, so they do not interfere. A member only serves requests once you tick it.',
        poolEnabledLabel: 'Automatic failover',
        poolEnabledHint: 'When on, running out of credit or hitting a rate limit switches to the next account. Turning it off only stops the switching — check-in and testing keep working.',
        poolEmpty: 'The pool is empty. Add an account by QR, or import the one the desktop app is signed in with.',
        poolAddQr: 'Add by QR',
        poolAddDesktop: 'Import desktop account',
        poolCheckin: 'Check in all',
        poolCheckinBusy: 'Checking in…',
        poolTest: 'Test',
        poolTesting: 'Testing…',
        poolRemove: 'Remove',
        poolRemoveConfirm: 'Confirm',
        poolStateUnknown: 'Untested',
        poolStateOk: 'Usable',
        poolStateLimited: 'Rate limited',
        poolStateEmpty: 'Out of credit',
        poolStateDead: 'Credential rejected',
        poolStateFlaky: 'Temporarily failing',
        poolActive: 'In use',
        poolCount: '{total} accounts · {enabled} enabled',
        poolDevice: 'device {device}',
        poolExpires: 'credential expires {time}',
        poolCoolUntil: 'cooling until {time}',
        poolCheckinAlready: 'already done today',
        poolCheckinGranted: 'granted',
        poolCheckinFailed: 'failed',
        poolAddHint: 'A newly added account starts disabled; tick it before it can serve requests.',
        poolImportOk: 'Desktop account imported.',
        poolAddBrowser: 'Sign in with browser',
        poolAddBrowserBusy: 'Opening…',
        poolBrowserHint: 'Sign in with your phone number or WeChat in the browser. When you are done the browser jumps back to this machine and the new account appears here. This is the same route the desktop app uses to switch accounts.',
        poolBrowserWaiting: 'Waiting for the browser to finish signing in (up to 5 minutes).',
        poolBrowserOpen: 'Open the authorize page',
        poolBrowserCancel: 'Stop waiting',
    };

    // ---------------------------------------------------------------- 样式

    var panelStyle = {
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        fontSize: '13px',
        lineHeight: '1.55',
        color: 'var(--dsh-text-primary, inherit)',
    };
    var sectionStyle = {
        border: '1px solid var(--dsh-panel-border, rgba(128,128,128,0.28))',
        borderRadius: '10px',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
    };
    var sectionTitleStyle = {
        fontSize: '12px',
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        opacity: 0.72,
    };
    var rowStyle = {
        display: 'flex',
        justifyContent: 'space-between',
        gap: '12px',
        alignItems: 'baseline',
    };
    var dimStyle = { opacity: 0.72 };
    var buttonStyle = {
        border: '1px solid var(--dsh-panel-border, rgba(128,128,128,0.4))',
        background: 'var(--dsh-button-bg, transparent)',
        color: 'inherit',
        borderRadius: '7px',
        padding: '4px 10px',
        fontSize: '12px',
        cursor: 'pointer',
        fontFamily: 'inherit',
    };
    var buttonPrimaryStyle = {
        border: '1px solid var(--dsh-accent, #4b7bec)',
        background: 'var(--dsh-accent, #4b7bec)',
        color: '#fff',
        borderRadius: '7px',
        padding: '5px 12px',
        fontSize: '12px',
        cursor: 'pointer',
        fontFamily: 'inherit',
    };
    var pillWrapStyle = { position: 'relative', display: 'inline-flex' };
    var pillButtonStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        border: '1px solid var(--dsh-panel-border, rgba(128,128,128,0.35))',
        borderRadius: '999px',
        padding: '2px 10px',
        fontSize: '12px',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
    };
    var pillDetailStyle = {
        position: 'absolute',
        bottom: 'calc(100% + 6px)',
        left: 0,
        zIndex: 40,
        minWidth: '190px',
        border: '1px solid var(--dsh-panel-border, rgba(128,128,128,0.35))',
        borderRadius: '9px',
        padding: '9px 11px',
        background: 'var(--dsh-panel-bg, #ffffff)',
        color: 'var(--dsh-text-primary, #111827)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.14)',
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
        fontSize: '12px',
    };
    /** 当前模型不是小浣熊时的弱化外观：仍然可读，但一眼看得出"不是正在用的那个"。 */
    var pillButtonDimStyle = Object.assign({}, pillButtonStyle, { opacity: 0.72 });
    var pillHintStyle = {
        marginTop: '6px',
        paddingTop: '6px',
        borderTop: '1px solid var(--dsh-panel-border, rgba(128,128,128,0.2))',
        fontSize: '11px',
        opacity: 0.7,
        lineHeight: 1.45,
        maxWidth: '220px',
    };
    var qrBoxStyle = {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '8px',
        padding: '10px',
        border: '1px solid var(--dsh-panel-border, rgba(128,128,128,0.28))',
        borderRadius: '10px',
        background: '#ffffff',
    };
    var modelRowStyle = {
        display: 'flex',
        justifyContent: 'space-between',
        gap: '10px',
        padding: '4px 0',
        borderBottom: '1px dashed var(--dsh-panel-border, rgba(128,128,128,0.2))',
    };
    var tagStyle = {
        fontSize: '11px',
        borderRadius: '5px',
        padding: '0 5px',
        border: '1px solid var(--dsh-panel-border, rgba(128,128,128,0.4))',
        whiteSpace: 'nowrap',
    };
    var preStyle = {
        margin: 0,
        padding: '9px 11px',
        borderRadius: '8px',
        background: 'var(--dsh-code-bg, rgba(128,128,128,0.1))',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '11.5px',
        lineHeight: '1.6',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        maxHeight: '240px',
        overflow: 'auto',
    };
    var inputStyle = {
        border: '1px solid var(--dsh-panel-border, rgba(128,128,128,0.4))',
        borderRadius: '6px',
        background: 'transparent',
        color: 'inherit',
        padding: '3px 7px',
        fontSize: '12px',
        width: '110px',
        fontFamily: 'inherit',
    };

    // ---------------------------------------------------------------- 工具

    function tFactory(dict) {
        return function translate(key, params) {
            var template = dict[key];
            if (template === undefined) return key;
            if (params === undefined) return template;
            return template.replace(/\{(\w+)\}/g, function (match, name) {
                var value = params[name];
                return value === undefined ? match : String(value);
            });
        };
    }

    /** 数字千分位。缺值给破折号 —— 不要给 0，那会被读成"余额是零"。 */
    function points(value) {
        if (value === undefined || value === null || !Number.isFinite(value)) return '—';
        return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
    }

    /** 1234567 → "1.2M"。只用于上下文窗口。 */
    function compact(value) {
        if (value === undefined || !Number.isFinite(value)) return '—';
        if (value < 1000) return String(value);
        if (value < 1000000) return (value / 1000).toFixed(value < 10000 ? 1 : 0) + 'k';
        return (value / 1000000).toFixed(value % 1000000 === 0 ? 0 : 1) + 'M';
    }

    function clockOf(epochMs) {
        if (epochMs === undefined || !Number.isFinite(epochMs)) return '—';
        var date = new Date(epochMs);
        return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' +
            String(date.getDate()).padStart(2, '0') + ' ' + String(date.getHours()).padStart(2, '0') + ':' +
            String(date.getMinutes()).padStart(2, '0');
    }

    function messageOf(error) {
        if (error === undefined || error === null) return '';
        if (typeof error === 'string') return error;
        if (typeof error.message === 'string') return error.message;
        return String(error);
    }

    // ---------------------------------------------------------------- store

    /**
     * 共享状态 store。
     *
     * 第一个订阅者进来时开始轮询，最后一个走了就停 —— 否则关掉设置页、
     * 界面切到别的会话之后还在后台打 status 端点。
     *
     * 间隔跟着登录阶段变：登录中要快（用户盯着二维码倒计时），
     * 平时慢（余额是分钟级变化的东西）。
     */
    var listeners = new Set();
    var snapshot;
    var lastError;
    var timer;
    var inflight = false;
    var reloadWanted = false;

    function nextDelay() {
        var login = snapshot === undefined ? undefined : snapshot.login;
        if (login !== undefined && (login.phase === 'pending' || login.phase === 'logging')) return POLL_LOGIN_MS;
        return POLL_IDLE_MS;
    }

    function notify() {
        listeners.forEach(function (listener) {
            try {
                listener(snapshot, lastError);
            } catch (error) {
                // 一个界面抛错不能带走另一个。
            }
        });
    }

    async function load() {
        // 已经在飞：**记下来**，等这一轮回来再补一次。
        //
        // 早先这里是直接 `return`，于是 `act()` 结尾的 `void load()` 有可能
        // 正好撞上一次轮询而在飞 —— 那次刷新被静默丢掉，用户点完「测试」
        // 或勾完开关后要等下一个 20 秒轮询才看到变化，看起来像按钮没生效。
        if (inflight) {
            reloadWanted = true;
            return;
        }
        inflight = true;
        try {
            var response = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } });
            if (response.ok) {
                snapshot = await response.json();
                lastError = undefined;
            } else {
                lastError = 'HTTP ' + response.status;
            }
        } catch (error) {
            // 保留上一份快照：宿主重启期间界面不该清空成"未登录"。
            lastError = messageOf(error);
        } finally {
            inflight = false;
        }
        notify();
        if (reloadWanted) {
            reloadWanted = false;
            void load();
            return;
        }
        scheduleNext();
    }

    function scheduleNext() {
        if (listeners.size === 0) return;
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(function () {
            timer = undefined;
            void load();
        }, nextDelay());
    }

    function subscribe(listener) {
        listeners.add(listener);
        if (snapshot !== undefined) listener(snapshot, lastError);
        if (listeners.size === 1) {
            void load();
            // 页面从后台回来时立刻拉一次：定时器在后台会被降频，
            // 用户切回来看到的第一眼不该是十分钟前的余额。
            if (typeof document !== 'undefined' && document.addEventListener !== undefined) {
                document.addEventListener('visibilitychange', onVisibility);
            }
        }
        return function unsubscribe() {
            listeners.delete(listener);
            if (listeners.size === 0) {
                if (timer !== undefined) {
                    clearTimeout(timer);
                    timer = undefined;
                }
                if (typeof document !== 'undefined' && document.removeEventListener !== undefined) {
                    document.removeEventListener('visibilitychange', onVisibility);
                }
            }
        };
    }

    function onVisibility() {
        if (typeof document === 'undefined') return;
        if (document.visibilityState === 'visible') void load();
    }

    /** 组件拿状态的标准方式。第二个返回值是"立刻刷新"。 */
    function useStatus() {
        var state = React.useState({ snapshot: snapshot, error: lastError });
        var setState = state[1];
        React.useEffect(function () {
            return subscribe(function (next, error) {
                setState({ snapshot: next, error: error });
            });
        }, []);
        return [state[0].snapshot, state[0].error, function () { void load(); }];
    }

    /**
     * 打一个 action。
     *
     * 无论成功失败都拉一次状态 —— 界面的唯一真相是宿主报的状态，
     * 不是这次请求的返回值。返回值只在需要显示具体错误时用。
     */
    async function act(action, body) {
        try {
            var response = await fetch(ACTION_PATH + '?action=' + encodeURIComponent(action), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body === undefined ? {} : body),
            });
            var payload = undefined;
            try {
                payload = await response.json();
            } catch (error) {
                payload = undefined;
            }
            return payload === undefined ? { ok: response.ok } : payload;
        } catch (error) {
            return { ok: false, error: messageOf(error) };
        } finally {
            void load();
        }
    }

    /** 倒计时。到 0 停在 0，不自己重开登录 —— 那要用户点。 */
    function useCountdown(deadline) {
        var state = React.useState(function () {
            return deadline === undefined ? 0 : Math.max(0, Math.round((deadline - Date.now()) / 1000));
        });
        var setSeconds = state[1];
        React.useEffect(function () {
            if (deadline === undefined) {
                setSeconds(0);
                return undefined;
            }
            function tick() {
                setSeconds(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
            }
            tick();
            var handle = setInterval(tick, 1000);
            return function () { clearInterval(handle); };
        }, [deadline]);
        return state[0];
    }

    // ---------------------------------------------------------------- 组件

    /**
     * 药丸。输入框左边那一条，跟模型选择器同一行。
     *
     * 显示的是**小浣熊账号的余额**，与当前选的是哪个模型无关。当前模型不是
     * 小浣熊时，展开详情里多一行提示 —— 说明"这个数字不会因为你用别的模型
     * 而变化"，而不是把整个药丸藏起来（那样用户会以为插件坏了）。
     */
    function CreditPill(props) {
        var statusPair = useStatus();
        var status = statusPair[0];
        var error = statusPair[1];
        var openState = React.useState(false);
        var open = openState[0];
        var setOpen = openState[1];
        var t = props.t;
        var selectedProvider = props.selectedProvider;
        var isCurrent = selectedProvider === undefined || selectedProvider === PROVIDER_ID;

        var label;
        var detail = null;

        if (status === undefined) {
            label = error === undefined ? t('pillLoading') : t('pillSignedOut');
        } else if (status.login !== undefined && (status.login.phase === 'expired' || status.login.phase === 'error')) {
            label = t('pillDead');
        } else if (status.publish === 'not-configured') {
            label = t('pillSignedOut');
        } else if (status.quota !== undefined && status.quota.available !== undefined) {
            label = t('pillQuota', { points: points(status.quota.available) });
        } else {
            label = t('pillUnknown');
        }

        if (open && status !== undefined) {
            var quota = status.quota || {};
            detail = h('div', { style: pillDetailStyle, 'data-raccoon-pill-detail': true },
                h('div', { style: rowStyle }, h('span', null, t('quotaAvailable')), h('span', null, points(quota.available))),
                h('div', { style: rowStyle }, h('span', null, t('quotaPermanent')), h('span', null, points(quota.permanent))),
                h('div', { style: rowStyle }, h('span', null, t('quotaDaily')), h('span', null, points(quota.daily))),
                h('div', { style: rowStyle },
                    h('span', null, t('providerTitle')),
                    h('span', { style: dimStyle }, publishText(t, status.publish))),
                isCurrent ? null : h('div', { style: pillHintStyle }, t('pillOtherModel')));
        }

        return h('div', { style: pillWrapStyle, 'data-raccoon-pill': true },
            h('button', {
                type: 'button',
                style: isCurrent ? pillButtonStyle : pillButtonDimStyle,
                title: t('title'),
                onClick: function () { setOpen(!open); },
            }, label),
            detail);
    }

    /**
     * 药丸的开关。
     *
     * ## 2026-11-11 改了主意：现在**总是显示**
     *
     * 原来只在"当前模型选的是小浣熊"时显示，理由是"显示别的 provider 的余额是
     * 误导"。这个理由本身没错，但它带来一个更糟的后果：用户的默认模型是
     * `workbuddy-global`（见 profile 的 `agent-default-model`），于是药丸永远
     * 不出现 —— 用户看到的是"插件坏了，积分不显示"，而不是"你没选小浣熊"。
     *
     * 判断"误导"的代价不该是"完全看不到自己的余额"。余额是小浣熊账号的资产，
     * 与当前选哪个模型无关；点开药丸的详情里本来就写着 `providerTitle`，
     * 想确认归属的人一眼就能看到。
     *
     * 所以这里保留 `useProjection` 的读取（它还能告诉我们选中的是哪个），但
     * 只用它来**标注**，不再用它来决定显不显示。
     */
    function CreditPillGate(props) {
        var selectedProvider;
        try {
            var projection = props.useProjection === undefined ? undefined : props.useProjection('modelSelection');
            var selected = projection === undefined ? undefined : (projection.next || projection.lastUsed);
            selectedProvider = selected === undefined || selected === null ? undefined : selected.provider;
        } catch (error) {
            selectedProvider = undefined;
        }
        return h(CreditPill, Object.assign({}, props, { selectedProvider: selectedProvider }));
    }

    function publishText(t, state) {
        if (state === 'published') return t('providerPublished');
        if (state === 'disabled') return t('providerDisabled');
        return t('providerNotConfigured');
    }

    function row(label, value, valueStyle) {
        return h('div', { style: rowStyle }, h('span', { style: dimStyle }, label), h('span', { style: valueStyle }, value));
    }

    function section(title, children) {
        return h('div', { style: sectionStyle }, h('div', { style: sectionTitleStyle }, title), children);
    }

    /**
     * 登录块。
     *
     * 四个相位各画各的，不做一套"通用状态机 UI"。`login.source === 'desktop'`
     * 时额外显示一行"来源：官方客户端"，并把「退出登录」替换成「读取客户端登录态」
     * —— 客户端凭据是**只读**的，我们不能替用户登出客户端，只能停止使用它
     * （ADR-0008；这一点必须让用户看见，否则「退出登录」点了没反应会被当成 bug）。
     */
    function LoginSection(props) {
        var t = props.t;
        var login = props.login;
        var refresh = props.refresh;
        var desktopAuth = props.desktopAuth || {};
        var busyState = React.useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];
        var errorState = React.useState(undefined);
        var error = errorState[0];
        var setError = errorState[1];

        var phase = login === undefined ? 'none' : login.phase;
        var fromDesktop = login !== undefined && login.source === 'desktop';
        var seconds = useCountdown(phase === 'pending' || phase === 'logging' ? login.deadline : undefined);

        function run(action) {
            setBusy(true);
            setError(undefined);
            void act(action).then(function (result) {
                setBusy(false);
                if (result !== undefined && result.ok === false) {
                    setError(result.error === undefined ? t('loginError') : String(result.error));
                }
                refresh();
            });
        }

        /** 桌面端没读到时的提示：区分"没装/没登录"和"过期"，因为处置完全不同。 */
        function desktopHint() {
            if (desktopAuth.found === true) return null;
            var reason = String(desktopAuth.reason === undefined ? '' : desktopAuth.reason);
            var text = reason.indexOf('过期') >= 0 ? t('loginDesktopExpired') : t('loginDesktopMissing');
            return h('div', { style: Object.assign({}, dimStyle, { fontSize: '12px' }) }, text);
        }

        /** 两个入口永远并列：读客户端登录态 / 扫码。用户不用猜该点哪个。 */
        function entryButtons() {
            return h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                h('button', {
                    type: 'button',
                    style: buttonPrimaryStyle,
                    disabled: busy,
                    onClick: function () { run('refresh-auth'); },
                }, t('loginRefreshAuth')),
                h('button', {
                    type: 'button',
                    style: buttonStyle,
                    disabled: busy,
                    onClick: function () { run('login-start'); },
                }, t('loginStart')));
        }

        var body;
        if (phase === 'ready') {
            var rows = [
                row(t('loginAccount'), login.principal === undefined ? '—' : login.principal),
                row(t('loginSource'), fromDesktop ? t('loginSourceDesktop') : t('loginSourceQr')),
                row(t('loginTokenKind'), login.kind === undefined ? '—' : login.kind),
                row(t('loginTokenExpires'), login.expiresAt === undefined ? t('loginNoExpiry') : clockOf(login.expiresAt)),
            ];
            body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                h('div', { style: rowStyle },
                    h('span', { style: { fontWeight: 600 } }, t('loginReady')),
                    h('button', {
                        type: 'button',
                        style: buttonStyle,
                        disabled: busy,
                        onClick: function () { run('logout'); },
                    }, t('loginOut'))),
                rows,
                fromDesktop
                    ? h('div', { style: Object.assign({}, dimStyle, { fontSize: '11.5px' }) }, t('loginDesktopReadonly'))
                    : null,
                entryButtons());
        } else if (phase === 'pending' || phase === 'logging') {
            // 这一轮扫码可能是「账号池」发起的（两个区共用一个 LoginFlow）。
            // 那种情况下二维码属于下面那个区，这里只说明一句，不重复显示 ——
            // 否则用户会以为上面这张是"换当前账号"的码，扫完却发现账号没变。
            var pendingIsPool = login !== undefined && login.mode === 'pool';
            body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                h('div', { style: rowStyle },
                    h('span', { style: { fontWeight: 600 } }, t(phase === 'logging' ? 'loginLogging' : 'loginPending')),
                    h('span', { style: dimStyle }, t('loginExpiresIn', { seconds: seconds }))),
                // 「扫了没反应」时，服务端到底回了什么只有这一行说得清。
                // 早先没有它，只能靠翻日志或重放请求去猜（2026-11-12 为此白跑一轮取证）。
                login.lastPoll === undefined
                    ? null
                    : h('div', { style: Object.assign({}, dimStyle, { fontSize: '11px', fontFamily: 'ui-monospace, monospace' }) },
                        t('loginLastPoll', { value: login.lastPoll })),
                pendingIsPool
                    ? h('div', { style: Object.assign({}, dimStyle, { fontSize: '12px' }) }, t('loginPoolBusy'))
                    : login.qrSvg === undefined
                        ? h('div', { style: dimStyle }, t('loginScanHint'))
                        : h('div', { style: qrBoxStyle },
                            h('div', {
                                style: { width: '168px', height: '168px', lineHeight: 0 },
                                dangerouslySetInnerHTML: { __html: login.qrSvg },
                            }),
                            h('div', { style: Object.assign({}, dimStyle, { fontSize: '11.5px', textAlign: 'center' }) }, t('loginScanHint'))),
                h('div', { style: { display: 'flex', gap: '8px' } },
                    h('button', {
                        type: 'button',
                        style: buttonPrimaryStyle,
                        disabled: busy,
                        onClick: function () { run('login-start'); },
                    }, t('loginRestart')),
                    h('button', {
                        type: 'button',
                        style: buttonStyle,
                        disabled: busy,
                        onClick: function () { run('login-cancel'); },
                    }, t('loginCancel')),
                    h('button', {
                        type: 'button',
                        style: buttonStyle,
                        disabled: busy,
                        onClick: function () { run('refresh-auth'); },
                    }, t('loginRefreshAuth'))));
        } else {
            var head = phase === 'expired' ? t('loginExpired') : phase === 'error' ? t('loginError') : t('loginNone');
            body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                h('div', { style: rowStyle },
                    h('span', { style: { fontWeight: 600 } }, head)),
                desktopHint(),
                login !== undefined && login.message !== undefined
                    ? h('div', { style: Object.assign({}, dimStyle, { fontSize: '12px' }) }, login.message)
                    : null,
                entryButtons());
        }

        return section(t('loginTitle'), h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            body,
            error === undefined ? null : h('div', { style: { color: 'var(--dsh-danger, #d64545)', fontSize: '12px' } }, error)));
    }

    function QuotaSection(props) {
        var t = props.t;
        var status = props.status;
        var busyState = React.useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];
        var quota = status.quota || {};

        var grantedText;
        if (quota.dailyGranted === true) grantedText = t('quotaGranted');
        else if (quota.dailyGranted === false) grantedText = t('quotaNotGranted');
        else grantedText = t('quotaGrantUnknown');

        return section(t('quotaTitle'), h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            row(t('quotaAvailable'), points(quota.available)),
            row(t('quotaPermanent'), points(quota.permanent)),
            row(t('quotaDaily'), points(quota.daily)),
            row(t('quotaGranted'), grantedText),
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginTop: '2px' } },
                h('span', { style: Object.assign({}, dimStyle, { fontSize: '11.5px' }) },
                    quota.at === 0 ? t('quotaNote') : t('quotaNote') + ' ' + t('quotaStale', { time: clockOf(quota.at) })),
                h('button', {
                    type: 'button',
                    style: buttonStyle,
                    disabled: busy,
                    onClick: function () {
                        setBusy(true);
                        void act('refresh-quota').then(function () { setBusy(false); });
                    },
                }, t('quotaRefresh'))),
            quota.error === undefined
                ? null
                : h('div', { style: { color: 'var(--dsh-danger, #d64545)', fontSize: '11.5px' } }, quota.error)));
    }

    function ModelsSection(props) {
        var t = props.t;
        var status = props.status;
        var busyState = React.useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];
        var probingState = React.useState(undefined);
        var probing = probingState[0];
        var setProbing = probingState[1];

        var models = status.models || [];

        function probe(modelId) {
            setProbing(modelId);
            void act('probe-vision', { model: modelId }).then(function () { setProbing(undefined); });
        }

        var list;
        if (models.length === 0) {
            list = h('div', { style: dimStyle }, t('modelsEmpty'));
        } else {
            list = h('div', { style: { display: 'flex', flexDirection: 'column' } }, models.map(function (model) {
                var tags = [];
                if (model.vision) tags.push(t('modelsVisionYes'));
                else tags.push(t('modelsVisionNo'));
                if (model.probed) tags.push(t('modelsVisionProbed'));
                return h('div', { key: model.id, style: modelRowStyle },
                    h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
                        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, model.name),
                        h('span', { style: Object.assign({}, dimStyle, { fontSize: '11px' }) },
                            t('modelsContext', { tokens: compact(model.contextWindow) }))),
                    h('div', { style: { display: 'flex', gap: '5px', alignItems: 'center', flexShrink: 0 } },
                        tags.map(function (tag, index) {
                            return h('span', { key: 'tag' + index, style: tagStyle }, tag);
                        }),
                        h('button', {
                            type: 'button',
                            style: Object.assign({}, buttonStyle, { fontSize: '11px', padding: '2px 6px' }),
                            disabled: probing !== undefined,
                            title: t('probeHint'),
                            onClick: function () { probe(model.id); },
                        }, probing === model.id ? t('probing') : t('probeButton'))));
            }));
        }

        return section(
            t('modelsTitle') + (models.length === 0 ? '' : ' · ' + t('modelsCount', { count: models.length })),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                list,
                h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
                    h('button', {
                        type: 'button',
                        style: buttonStyle,
                        disabled: busy,
                        onClick: function () {
                            setBusy(true);
                            void act('refresh-catalog').then(function () { setBusy(false); });
                        },
                    }, t('modelsRefresh'))),
                status.catalogError === undefined
                    ? null
                    : h('div', { style: { color: 'var(--dsh-danger, #d64545)', fontSize: '11.5px' } }, status.catalogError)));
    }

    function Switch(props) {
        var t = props.t;
        return h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
            h('input', {
                type: 'checkbox',
                checked: props.checked === true,
                disabled: props.disabled === true,
                onChange: function (event) { props.onChange(event.target.checked); },
            }),
            h('span', null, props.label));
    }

    function SettingsSection(props) {
        var t = props.t;
        var status = props.status;
        var settings = status.settings || {};
        var capState = React.useState(String(settings.contextCap === undefined ? '' : settings.contextCap));
        var capText = capState[0];
        var setCapText = capState[1];
        var messageState = React.useState(undefined);
        var message = messageState[0];
        var setMessage = messageState[1];

        React.useEffect(function () {
            setCapText(String(settings.contextCap === undefined ? '' : settings.contextCap));
        }, [settings.contextCap]);

        function set(key, value) {
            setMessage(undefined);
            void act('set-setting', { key: key, value: value }).then(function (result) {
                if (result !== undefined && result.ok === false) {
                    setMessage(result.error === undefined ? t('errAction', { message: 'unknown' }) : String(result.error));
                }
            });
        }

        function commitCap() {
            var parsed = Number(capText);
            if (!Number.isFinite(parsed) || parsed < 8192 || parsed > 2000000) {
                setCapText(String(settings.contextCap));
                setMessage('8192 – 2000000');
                return;
            }
            set('contextCap', Math.round(parsed));
        }

        return section(t('settingsTitle'), h('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px' } },
            h('div', null,
                h('div', { style: rowStyle },
                    h('span', null, t('settingAuthSource')),
                    h('select', {
                        style: inputStyle,
                        value: settings.authSource === undefined ? 'auto' : settings.authSource,
                        onChange: function (event) { set('authSource', event.target.value); },
                    },
                        h('option', { value: 'auto' }, t('settingAuthAuto')),
                        h('option', { value: 'desktop' }, t('settingAuthDesktop')),
                        h('option', { value: 'qr' }, t('settingAuthQr')))),
                h('div', { style: Object.assign({}, dimStyle, { fontSize: '11.5px', marginLeft: '0px' }) }, t('settingAuthHint'))),
            h('div', null,
                h('div', { style: rowStyle },
                    h('span', null, t('settingQrProtocol')),
                    h('select', {
                        style: inputStyle,
                        value: settings.qrProtocol === undefined ? 'web' : settings.qrProtocol,
                        onChange: function (event) { set('qrProtocol', event.target.value); },
                    },
                        h('option', { value: 'web' }, t('settingQrWeb')),
                        h('option', { value: 'iam' }, t('settingQrIam')))),
                h('div', { style: Object.assign({}, dimStyle, { fontSize: '11.5px', marginLeft: '0px' }) }, t('settingQrHint'))),
            h('div', null,
                h(Switch, {
                    t: t,
                    label: t('settingEnabled'),
                    checked: settings.enabled,
                    onChange: function (next) { set('enabled', next); },
                }),
                h('div', { style: Object.assign({}, dimStyle, { fontSize: '11.5px', marginLeft: '22px' }) }, t('providerHint'))),
            h('div', null,
                h(Switch, {
                    t: t,
                    label: t('settingReasoning'),
                    checked: settings.reasoning,
                    onChange: function (next) { set('reasoning', next); },
                }),
                h('div', { style: Object.assign({}, dimStyle, { fontSize: '11.5px', marginLeft: '22px' }) }, t('settingReasoningHint'))),
            h('div', { style: rowStyle },
                h('span', null, t('settingCap')),
                h('input', {
                    type: 'number',
                    step: '1024',
                    min: '8192',
                    max: '2000000',
                    style: inputStyle,
                    value: capText,
                    onChange: function (event) { setCapText(event.target.value); },
                    onBlur: commitCap,
                    onKeyDown: function (event) {
                        if (event.key === 'Enter') commitCap();
                    },
                })),
            h('div', { style: Object.assign({}, dimStyle, { fontSize: '11.5px' }) }, t('settingCapHint')),
            h('div', null,
                h(Switch, {
                    t: t,
                    label: t('settingDebug'),
                    checked: settings.debugLog,
                    onChange: function (next) { set('debugLog', next); },
                }),
                h('div', { style: Object.assign({}, dimStyle, { fontSize: '11.5px', marginLeft: '22px' }) }, t('settingDebugHint'))),
            message === undefined
                ? null
                : h('div', { style: { color: 'var(--dsh-danger, #d64545)', fontSize: '11.5px' } }, message)));
    }

    /**
     * 账号池。
     *
     * 三个约束来自 ADR-0010，改这里之前先读它：
     * 1. 开关只控制"插件要不要自己决定用谁"，不控制"你能不能操作" —— 所以
     *    关掉自动换号时，签到与测试按钮仍然可用（workbuddy 曾把按钮挂在开关上，
     *    结果关掉后再也没法签到）。
     * 2. 勾选是即时生效的写操作，失败要回滚显示 —— 界面的真相是宿主报的状态，
     *    不是这次请求的返回值（`act()` 无论成败都会 `load()`）。
     * 3. 删除做两段式，不用 `window.confirm` —— 有些宿主会拦原生对话框，
     *    拦了之后按钮就彻底没反应了。
     */
    function PoolSection(props) {
        var t = props.t;
        var status = props.status;
        var pool = status.pool || {};
        var accounts = Array.isArray(pool.accounts) ? pool.accounts : [];
        var settings = status.settings || {};
        var busyState = React.useState('');
        var busy = busyState[0];
        var setBusy = busyState[1];
        var confirmState = React.useState('');
        var confirming = confirmState[0];
        var setConfirming = confirmState[1];
        var messageState = React.useState(undefined);
        var message = messageState[0];
        var setMessage = messageState[1];
        // 扫码加号时的二维码。**不复用上面那个登录块** —— 那是"当前账号"的
        // 登录入口，而这里加的是池成员；两者相位不同（ADR-0010 §4），
        // 混在一起会让用户以为加号会顶掉当前账号。
        var qrState = React.useState(undefined);
        var pendingQr = qrState[0];
        var setPendingQr = qrState[1];
        // 「一键签到」的逐号结果。宿主已经按号返回 `results` 了，不显示出来
        // 用户就只能看到一个按钮转两秒然后什么都没变 —— 签到是每天一次的
        // 动作，用户最想知道的是"哪个号领到了、哪个号失败了"。
        var checkinState = React.useState({});
        var checkins = checkinState[0];
        var setCheckins = checkinState[1];

        // 浏览器登录状态。**从 status 读，不自己记** —— 一轮可能在用户切走
        // 设置卡、切回来之后还在等（`/authorize` 是用户在浏览器里操作的，
        // 可能花一两分钟），自己记就丢了。
        var browser = status.browser || {};
        var browserActive = browser.active === true;
        var browserUrl = browser.url === undefined ? '' : String(browser.url);

        // 二维码要跟着宿主的状态走，不能停在点按钮那一刻的快照 ——
        // 用户盯着看的是"还剩多少秒"和"扫了没有"，而这两件事只有宿主知道。
        //
        // 还必须认领 `login.mode === 'pool'`：设置卡的「登录」区和这里的
        // 「账号池」区共用同一个 LoginFlow。用户在登录区点一次扫码，会把
        // 这里正在等的池二维码取消掉（`start()` 先 cancel 再取码），此时
        // 相位仍是 pending —— 只看相位的话这里会继续显示一张已经属于主登录
        // 的二维码，用户扫完 token 写进 token.json 而不是池里。
        var login = status.login || {};
        var scanning = pendingQr !== undefined
            && login.mode === 'pool'
            && (login.phase === 'pending' || login.phase === 'logging');
        React.useEffect(function () {
            if (pendingQr === undefined) return;
            if (login.mode === 'pool' && (login.phase === 'pending' || login.phase === 'logging')) return;
            // 这一轮结束了（扫成功、过期、被取消），或者被主登录抢走了 —— 收起二维码。
            setPendingQr(undefined);
        }, [login.phase, login.mode]);

        function run(action, body, note) {
            setMessage(undefined);
            // 新一轮签到开始就清掉上一轮的结果，否则失败的号会一直挂着红字。
            if (action === 'pool-checkin') setCheckins({});
            setBusy(action + (body !== undefined && body.id !== undefined ? ':' + body.id : ''));
            void act(action, body).then(function (result) {
                setBusy('');
                if (result === undefined) return;
                if (result.ok === false) {
                    setPendingQr(undefined);
                    setMessage(result.error === undefined ? t('errAction', { message: 'unknown' }) : String(result.error));
                    return;
                }
                if (action === 'pool-add-start') {
                    setPendingQr(result.login === undefined ? undefined : result.login);
                }
                if (action === 'pool-checkin' && Array.isArray(result.results)) {
                    var next = {};
                    for (var i = 0; i < result.results.length; i += 1) {
                        var item = result.results[i];
                        if (item !== undefined && typeof item.id === 'string') next[item.id] = item;
                    }
                    setCheckins(next);
                }
                if (note !== undefined) setMessage(note);
            });
        }

        function toggleAccount(account, next) {
            // 乐观更新不做：`act()` 结束会拉一次 status，闪烁一次比"显示成功但没生效"好。
            run('pool-toggle', { id: account.id, enabled: next });
        }

        function removeAccount(account) {
            if (confirming !== account.id) {
                setConfirming(account.id);
                return;
            }
            setConfirming('');
            run('pool-remove', { id: account.id });
        }

        function stateText(measure) {
            if (measure === undefined) return t('poolStateUnknown');
            if (measure.state === 'ok') return t('poolStateOk');
            if (measure.state === 'limited') return t('poolStateLimited');
            if (measure.state === 'empty') return t('poolStateEmpty');
            if (measure.state === 'dead') return t('poolStateDead');
            return t('poolStateFlaky');
        }

        function stateColor(measure) {
            if (measure === undefined) return 'var(--dsh-text-secondary, #6b7280)';
            if (measure.state === 'ok') return 'var(--dsh-success, #2f9e44)';
            if (measure.state === 'dead') return 'var(--dsh-danger, #d64545)';
            return 'var(--dsh-warning, #e08c00)';
        }

        function accountCard(account) {
            var measure = account.measure;
            var cooling = measure !== undefined && measure.until !== undefined && measure.until > Date.now();
            var lines = [];
            lines.push(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                h('input', {
                    type: 'checkbox',
                    checked: account.enabled === true,
                    disabled: busy !== '',
                    onChange: function (event) { toggleAccount(account, event.target.checked); },
                }),
                h('span', { style: { fontWeight: 600, fontFamily: 'ui-monospace, monospace', fontSize: '12px' } }, account.id.slice(0, 8)),
                account.active === true
                    ? h('span', { style: { fontSize: '11px', padding: '1px 6px', borderRadius: '999px', border: '1px solid var(--dsh-accent, #4b7bec)', color: 'var(--dsh-accent, #4b7bec)' } }, t('poolActive'))
                    : null,
                h('span', { style: { marginLeft: 'auto', fontSize: '11.5px', color: stateColor(measure) } }, stateText(measure))));
            lines.push(h('div', { style: Object.assign({}, dimStyle, { fontSize: '11px', display: 'flex', flexWrap: 'wrap', gap: '10px' }) },
                h('span', null, account.principal === undefined ? '—' : account.principal),
                h('span', null, t('poolDevice', { device: account.device === undefined ? '—' : account.device })),
                account.expiresAt === undefined ? null : h('span', null, t('poolExpires', { time: clockOf(account.expiresAt) })),
                cooling ? h('span', { style: { color: 'var(--dsh-warning, #e08c00)' } }, t('poolCoolUntil', { time: clockOf(measure.until) })) : null));
            if (measure !== undefined && measure.note !== undefined) {
                lines.push(h('div', { style: Object.assign({}, dimStyle, { fontSize: '11px' }) }, measure.note));
            }
            var checkin = checkins[account.id];
            if (checkin !== undefined) {
                var failed = checkin.result === 'error';
                var label = checkin.result === 'granted'
                    ? t('poolCheckinGranted')
                    : checkin.result === 'already'
                        ? t('poolCheckinAlready')
                        : t('poolCheckinFailed');
                lines.push(h('div', {
                    style: {
                        fontSize: '11px',
                        color: failed ? 'var(--dsh-danger, #d64545)' : 'var(--dsh-success, #2f9e44)',
                    },
                    'data-raccoon-checkin': account.id,
                }, failed && checkin.message !== undefined ? label + ' · ' + String(checkin.message).split('\n')[0] : label));
            }
            lines.push(h('div', { style: { display: 'flex', gap: '8px', marginTop: '2px' } },
                h('button', {
                    type: 'button',
                    style: buttonStyle,
                    disabled: busy !== '',
                    onClick: function () { run('pool-test', { id: account.id }); },
                }, busy === 'pool-test:' + account.id ? t('poolTesting') : t('poolTest')),
                h('button', {
                    type: 'button',
                    style: confirming === account.id
                        ? Object.assign({}, buttonStyle, { borderColor: 'var(--dsh-danger, #d64545)', color: 'var(--dsh-danger, #d64545)' })
                        : buttonStyle,
                    disabled: busy !== '',
                    onClick: function () { removeAccount(account); },
                }, confirming === account.id ? t('poolRemoveConfirm') : t('poolRemove'))));
            return h('div', {
                style: {
                    border: '1px solid var(--dsh-panel-border, rgba(128,128,128,0.2))',
                    borderRadius: '8px',
                    padding: '9px 11px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                    'data-raccoon-account': account.id,
                },
            }, lines);
        }

        var header = h('div', { style: rowStyle },
            h('span', null, t('poolCount', { total: pool.total === undefined ? 0 : pool.total, enabled: pool.enabledCount === undefined ? 0 : pool.enabledCount })),
            h('span', { style: Object.assign({}, dimStyle, { fontSize: '11.5px' }) },
                busy === 'pool-checkin' ? t('poolCheckinBusy') : ''));

        return section(t('poolTitle'), h('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px' } },
            h('div', null,
                h(Switch, {
                    t: t,
                    label: t('poolEnabledLabel'),
                    checked: settings.poolEnabled === true,
                    onChange: function (next) { run('set-setting', { key: 'poolEnabled', value: next }); },
                }),
                h('div', { style: Object.assign({}, dimStyle, { fontSize: '11.5px', marginLeft: '22px' }) }, t('poolEnabledHint'))),
            h('div', { style: Object.assign({}, dimStyle, { fontSize: '11.5px' }) }, t('poolHint')),
            header,
            accounts.length === 0
                ? h('div', { style: Object.assign({}, dimStyle, { fontSize: '12px' }) }, t('poolEmpty'))
                : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px' } }, accounts.map(accountCard)),
            pool.note === undefined
                ? null
                : h('div', { style: Object.assign({}, dimStyle, { fontSize: '11.5px' }) }, pool.note),
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                h('button', {
                    type: 'button',
                    style: buttonStyle,
                    disabled: busy !== '' || browserActive,
                    onClick: function () { run('pool-add-browser'); },
                }, busy === 'pool-add-browser' ? t('poolAddBrowserBusy') : t('poolAddBrowser')),
                h('button', {
                    type: 'button',
                    style: buttonStyle,
                    disabled: busy !== '',
                    onClick: function () { run('pool-add-start'); },
                }, t('poolAddQr')),
                h('button', {
                    type: 'button',
                    style: buttonStyle,
                    disabled: busy !== '',
                    onClick: function () { run('pool-import-desktop', undefined, t('poolImportOk')); },
                }, t('poolAddDesktop')),
                h('button', {
                    type: 'button',
                    style: buttonPrimaryStyle,
                    disabled: busy !== '' || accounts.length === 0,
                    onClick: function () { run('pool-checkin'); },
                }, busy === 'pool-checkin' ? t('poolCheckinBusy') : t('poolCheckin'))),
            h('div', { style: Object.assign({}, dimStyle, { fontSize: '11px' }) }, t('poolAddHint')),
            browserActive
                ? h('div', {
                    style: {
                        border: '1px solid var(--dsh-panel-border, rgba(128,128,128,0.2))',
                        borderRadius: '8px',
                        padding: '10px 12px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '7px',
                    },
                    'data-raccoon-browser': true,
                },
                    h('div', { style: { fontSize: '12px' } }, t('poolBrowserWaiting')),
                    h('div', { style: Object.assign({}, dimStyle, { fontSize: '11.5px' }) }, t('poolBrowserHint')),
                    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                        h('a', {
                            style: Object.assign({}, buttonPrimaryStyle, { textDecoration: 'none', display: 'inline-block' }),
                            href: browserUrl,
                            target: '_blank',
                            rel: 'noreferrer noopener',
                        }, t('poolBrowserOpen')),
                        h('button', {
                            type: 'button',
                            style: buttonStyle,
                            disabled: busy !== '',
                            onClick: function () { run('pool-add-browser-cancel'); },
                        }, t('poolBrowserCancel'))))
                : null,
            browser.active !== true && browser.message !== undefined
                ? h('div', { style: Object.assign({}, dimStyle, { fontSize: '11.5px' }) }, String(browser.message))
                : null,
            scanning && login.qrSvg !== undefined
                ? h('div', { style: qrBoxStyle },
                    h('div', {
                        style: { width: '168px', height: '168px', lineHeight: 0 },
                        dangerouslySetInnerHTML: { __html: login.qrSvg },
                    }),
                    h('div', { style: Object.assign({}, dimStyle, { fontSize: '11.5px', textAlign: 'center' }) }, t('loginScanHint')),
                    // 加号失败时最想知道的是服务端回了什么，与上面「登录」区同一行诊断。
                    login.lastPoll === undefined
                        ? null
                        : h('div', { style: Object.assign({}, dimStyle, { fontSize: '11px', fontFamily: 'ui-monospace, monospace' }) },
                            t('loginLastPoll', { value: login.lastPoll })))
                : null,
            message === undefined
                ? null
                : h('div', { style: { color: 'var(--dsh-danger, #d64545)', fontSize: '11.5px' } }, message)));
    }

    function DiagnosticsSection(props) {
        var t = props.t;
        var status = props.status;
        var copiedState = React.useState(false);
        var copied = copiedState[0];
        var setCopied = copiedState[1];

        function copy() {
            var text = String(status.diagnostics === undefined ? '' : status.diagnostics);
            var done = function () {
                setCopied(true);
                setTimeout(function () { setCopied(false); }, 1600);
            };
            if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
                void navigator.clipboard.writeText(text).then(done, function () { done(); });
            } else {
                done();
            }
        }

        return section(t('diagTitle'), h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            h('pre', { style: preStyle, 'data-raccoon-diagnostics': true }, String(status.diagnostics === undefined ? '' : status.diagnostics)),
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' } },
                h('span', { style: Object.assign({}, dimStyle, { fontSize: '11.5px' }) }, t('diagHint')),
                h('button', { type: 'button', style: buttonStyle, onClick: copy }, copied ? t('diagCopied') : t('diagCopy')))));
    }

    /** 插件页。`plugins.bundle.config` slot 渲染这个。 */
    function PluginPage(props) {
        var statusPair = useStatus();
        var status = statusPair[0];
        var error = statusPair[1];
        var refresh = statusPair[2];
        var t = props.t;

        if (status === undefined) {
            return h('div', { style: panelStyle, 'data-raccoon-page': true },
                h('div', { style: dimStyle }, error === undefined ? t('pillLoading') : t('errNetwork')));
        }

        return h('div', { style: panelStyle, 'data-raccoon-page': true },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px' } },
                h('div', null,
                    h('div', { style: { fontSize: '15px', fontWeight: 600 } }, t('pageTitle')),
                    h('div', { style: Object.assign({}, dimStyle, { fontSize: '11.5px' }) }, t('pageSubtitle'))),
                h('span', { style: Object.assign({}, dimStyle, { fontSize: '11px', whiteSpace: 'nowrap' }) },
                    t('buildLabel', { build: status.build }) +
                    (status.build === BUILD ? '' : ' ⚠'))),
            LoginSection({ t: t, login: status.login, refresh: refresh, desktopAuth: status.desktopAuth }),
            section(t('providerTitle'), h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                row(t('providerTitle'), publishText(t, status.publish)),
                status.catalogReady ? null : h('div', { style: Object.assign({}, dimStyle, { fontSize: '11.5px' }) }, t('modelsEmpty')))),
            QuotaSection({ t: t, status: status }),
            ModelsSection({ t: t, status: status }),
            PoolSection({ t: t, status: status }),
            SettingsSection({ t: t, status: status }),
            DiagnosticsSection({ t: t, status: status }),
            error === undefined
                ? null
                : h('div', { style: { color: 'var(--dsh-danger, #d64545)', fontSize: '11.5px' } }, t('errNetwork')));
    }

    // ---------------------------------------------------------------- 挂载

    /**
     * React 与 `h` 是**模块级**变量，在 factory 里才赋值。
     *
     * 组件都定义在这个 IIFE 的作用域里（只有这样才能共享 store 与文案），
     * 所以它们必须引用同一个 `h` —— 把 `h` 写在 factory 里会变成
     * "组件里 h 未定义"，第一次渲染就炸。这个坑值得写一行注释：
     * classic script 没有模块提升，靠的是"factory 一定先于任何渲染执行"。
     */
    var React = undefined;
    var h = undefined;

    /**
     * 拿翻译函数，拿不到也不抛。
     *
     * 正常路径是 `ctx.locale.bind(NAMESPACE)`。但在 `locale` 服务缺席、或它的
     * `bind` 因为任何原因不可用时，整个 apply 不能因此崩掉 —— 界面用 key 当
     * 文案（`t('title') === 'title'`）虽然难看，但比"设置页一片空白"强。
     */
    function bindTranslator(ctx) {
        try {
            if (ctx.locale !== undefined && typeof ctx.locale.bind === 'function') {
                var bound = ctx.locale.bind(NAMESPACE);
                if (typeof bound === 'function') return bound;
            }
        } catch (error) {
            console.warn('[' + BUNDLE_NAME + '] locale bind failed, falling back to raw keys:', error);
        }
        return function fallbackTranslate(key) { return key; };
    }

    /**
     * 把一步 slot 注册单独兜住。
     *
     * 一个 slot 挂不上（宿主没声明它、注册被守卫拒、组件形态不被接受）不该
     * 连累另外两个。错误照旧打到 console，排障时还能看见。
     */
    function guard(label, step) {
        try {
            step();
        } catch (error) {
            console.error('[' + BUNDLE_NAME + '] slot "' + label + '" failed to register:', error);
        }
    }

    var loader = globalThis.__ModuleLoader__;
    if (loader === undefined) {
        // 宿主没有模块加载器：说明这个脚本被当普通页面脚本执行了。
        // 什么都不做比抛错好 —— 抛错只会在控制台里留一条没人看的红字。
        return;
    }

    loader.load({
        id: BUNDLE_NAME,
        factory: function factory(require) {
            React = require('react');
            h = React.createElement;

            return {
                inject: ['slots', 'locale'],
                apply: function apply(ctx) {
                    // ── 为什么每一步都单独 try/catch ───────────────────────────
                    // DSH 0.2.2 的 `locale.register()` 在**同一 namespace 的同一
                    // locale 已存在时抛错**：
                    //   `locale namespace "x" already has locale "zh"`
                    // 而 `apply` 一旦抛错，它后面所有的 `slots.inject(...)` 全都不
                    // 执行 —— 表现为"积分药丸消失 + 设置页空白"同时出现，看起来
                    // 像两个 bug，其实是一个。
                    //
                    // 触发条件很现实：profile 里同一个包被加载两次（重复 insert，
                    // 用户手工清理插件时很容易留下），两次 apply 跑同一个闭包，
                    // 第二次就炸。所以这里的每一步都必须自己兜住自己的错，
                    // 任何一步失败都不能连累其它两步。
                    var t = bindTranslator(ctx);

                    // 1) 语言包。重复注册是可恢复的（旧的还在，翻译照样能用）。
                    try {
                        ctx.effect(function () {
                            return ctx.locale.register(NAMESPACE, { zh: zh, en: en });
                        }, BUNDLE_NAME + ': locale');
                    } catch (error) {
                        console.warn('[' + BUNDLE_NAME + '] locale registration skipped:', error);
                    }

                    // 2) 输入框左侧：余额药丸。order 4 与 minimaxcode 一致 ——
                    //    两个插件的药丸不该互相挤位置。
                    guard('conversation.input.left', function () {
                        ctx.slots.inject('conversation.input.left', function () {
                            return ctx.slots.register({
                                name: 'conversation.input.left',
                                id: 'raccoon-credits',
                                order: 4,
                                locale: NAMESPACE,
                                inject: function () { return { t: t }; },
                            }, CreditPillGate);
                        });
                    });

                    // 3) 插件自己的设置页（「插件」面板 → 包详情）。key 必须是包名。
                    guard('plugins.bundle.config', function () {
                        ctx.slots.inject('plugins.bundle.config', function () {
                            return ctx.slots.register({
                                name: 'plugins.bundle.config',
                                key: BUNDLE_NAME,
                                locale: NAMESPACE,
                                inject: function () { return { t: t }; },
                            }, PluginPage);
                        });
                    });

                    // 4) 设置对话框左侧菜单。设置页走的是 `settings.section`
                    //    （kind=list, scope=root），与 `plugins.bundle.config` 不是
                    //    同一个界面 —— 之前只注册了后者，所以「设置里找不到入口」
                    //    （2026-11-06 实测）。同款写法见 dsh-better-sidebar。
                    //
                    //    用一层包装组件闭包捕获 t，不依赖内核把 inject 返回值合成
                    //    props 的具体方式；同时透传 sectionProps，让宿主给的 close 等不丢。
                    guard('settings.section', function () {
                        ctx.slots.inject('settings.section', function () {
                            var RaccoonSettingsSection = function (sectionProps) {
                                return h(PluginPage, Object.assign({}, sectionProps, { t: t }));
                            };
                            return ctx.slots.register({
                                name: 'settings.section',
                                id: BUNDLE_NAME,
                                order: 95,
                                label: function () { return t('title'); },
                                locale: NAMESPACE,
                            }, RaccoonSettingsSection);
                        });
                    });
                },
            };
        },
    });

    // 让排障时能一眼确认浏览器加载的是哪一版（docs/04-ops/01-troubleshooting.md §2）。
    globalThis.__DSH_BUILD_raccoon = BUILD;
})();
