import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { readMyOpsConfig } from "./config.js";

export const MY_OPS_GUIDE_PATH = "/my-ops/guide";

type GuideAction = {
  label: string;
  example: string;
};

type GuideItem = {
  id: string;
  title: string;
  short: string;
  area: string;
  status: "ready" | "adapter" | "planned" | "core";
  summary: string;
  tips: string[];
  actions: GuideAction[];
};

type GuideRenderItem = GuideItem & {
  statusText: string;
  statusClass: "ready" | "warn" | "muted";
};

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function getGuideItems(api: OpenClawPluginApi): GuideRenderItem[] {
  const cfg = readMyOpsConfig(api.pluginConfig);

  const items: GuideItem[] = [
    {
      id: "mail",
      title: "邮件管理",
      short: "Mail",
      area: "my-ops / himalaya",
      status: cfg.adapters.mail.command ? "ready" : "adapter",
      summary: "统一走 ops_mail，底层用 Himalaya 适配，避免把 CLI 细节暴露给模型。",
      tips: [
        "先跑 health 和 list_messages，确认账号/文件夹配置正确，再接入自动化。",
        "写操作（发信）建议放进 Lobster 审批流，send_message 一定带 idempotencyKey。",
        "建议流程：list_messages -> get_message -> draft_reply ->（确认）-> send_message。",
        "多邮箱汇总/垃圾清理优先用 /ops mail summary、/ops mail junk list/clear（默认 dry-run）。",
        "定时轮询时用 Message-ID 或 UID 做去重，避免重复处理同一封邮件。",
      ],
      actions: [
        { label: "账号列表（托底）", example: "/ops mail accounts" },
        { label: "多邮箱汇总（托底）", example: "/ops mail summary --limit 5" },
        { label: "垃圾预览（托底）", example: "/ops mail junk list --limit 20" },
        {
          label: "垃圾清理演练（托底）",
          example: "/ops mail junk clear --accounts owenshen-gmail --limit 50 --dry-run",
        },
        { label: "健康检查", example: '{ "action": "health" }' },
        {
          label: "列出收件箱",
          example: '{ "action": "list_messages", "payload": { "folder": "INBOX", "limit": 20 } }',
        },
        {
          label: "读取邮件",
          example:
            '{ "action": "get_message", "payload": { "id": "<message-id>", "folder": "INBOX" } }',
        },
        {
          label: "草拟回复",
          example:
            '{ "action": "draft_reply", "payload": { "id": "<message-id>", "replyAll": false } }',
        },
        {
          label: "发送邮件（必须幂等）",
          example:
            '{ "action": "send_message", "idempotencyKey": "mail-20260222-001", "payload": { "template": "<draft template>", "requireIdempotencyKey": true } }',
        },
      ],
    },
    {
      id: "calendar",
      title: "日历管理",
      short: "Calendar",
      area: "my-ops adapter",
      status: cfg.adapters.calendar.command ? "ready" : "adapter",
      summary:
        "建议做 calendar_list/create/update/cancel 的强类型适配器，再交给 cron/heartbeat 调度。",
      tips: [
        "先把读操作做稳（list/search），再做 create/update/cancel。",
        "提醒与巡检用 heartbeat；固定时间触发用 cron，避免模型“记忆式”执行。",
        "所有写操作保留 eventId / etag，更新时做并发控制更稳。",
        "移动端/聊天里要稳时，优先用 /ops calendar today|week|list / create / update / delete 托底命令。",
      ],
      actions: [
        { label: "日历列表（托底）", example: "/ops calendar calendars" },
        { label: "今天日程（托底）", example: "/ops calendar today --limit 20" },
        { label: "本周日程（托底）", example: "/ops calendar week --limit 50" },
        {
          label: "创建日程（托底）",
          example:
            '/ops calendar create --title "周会" --start 2026-02-23T10:00:00+08:00 --end 2026-02-23T11:00:00+08:00 --dry-run',
        },
        {
          label: "列事件（示例）",
          example:
            '{ "action": "list_events", "payload": { "start": "2026-02-22T00:00:00+08:00", "end": "2026-02-23T00:00:00+08:00" } }',
        },
        {
          label: "创建事件（示例）",
          example:
            '{ "action": "create_event", "payload": { "title": "周会", "start": "...", "end": "...", "attendees": [] } }',
        },
      ],
    },
    {
      id: "mowen",
      title: "墨问",
      short: "Mowen",
      area: "my-ops adapter",
      status: cfg.adapters.mowen.command ? "ready" : "adapter",
      summary:
        "把墨问操作封装成稳定 adapter（mowen_note/mowen_doc/...），避免 skill 驱动浏览器操作。",
      tips: [
        "如果没有稳定 API，先做你自己的本地适配层，屏蔽页面结构变化。",
        "动作名保持明确（create_doc/update_doc/set_doc/upload_url），不要做“大一统自然语言输入”。",
        "托底发布优先用 /ops mowen fetch/post/edit（支持飞书 Docx/Wiki 链接），出问题时更好排查。",
        "记录外部请求日志与错误码，便于定位平台侧变化。",
      ],
      actions: [
        {
          label: "托底预览（推荐）",
          example: "/ops mowen fetch https://feishu.cn/wiki/XXX",
        },
        {
          label: "托底发布私有（推荐）",
          example: "/ops mowen post https://feishu.cn/wiki/XXX --private",
        },
        {
          label: "托底编辑（推荐）",
          example: "/ops mowen edit <noteId> https://feishu.cn/wiki/XXX",
        },
        {
          label: "发布私有文章（示例）",
          example:
            '{ "action": "create_doc", "payload": { "text": "标题\\n正文", "autoPublish": true } }',
        },
        {
          label: "编辑文章（示例）",
          example:
            '{ "action": "update_doc", "payload": { "noteId": "xxx", "text": "更新后的正文" } }',
        },
        {
          label: "设为私有（示例）",
          example:
            '{ "action": "set_doc", "payload": { "noteId": "xxx", "privacy": { "type": "private" } } }',
        },
      ],
    },
    {
      id: "feishu",
      title: "飞书文档",
      short: "Feishu",
      area: "extensions/feishu",
      status: "ready",
      summary: "优先复用现成飞书插件能力（文档 / Drive / Wiki / Bitable），再用工作流编排调用。",
      tips: [
        "飞书能力尽量直接走现成插件工具，减少重复造轮子。",
        "写文档类操作建议先生成草稿内容，再人工确认后提交。",
        "把常用模板（日报、会议纪要）做成固定 prompt/工作流输入结构。",
      ],
      actions: [
        {
          label: "查看插件状态",
          example: "/status --deep",
        },
        {
          label: "在工作流中调用",
          example: "Lobster: draft -> review -> feishu write",
        },
      ],
    },
    {
      id: "schedule",
      title: "定时任务",
      short: "Cron / Heartbeat",
      area: "core automation",
      status: "core",
      summary: "用内建 cron + heartbeat 做调度，不靠 skill 临时触发，执行链路更可控。",
      tips: [
        "cron 适合精确时间；heartbeat 适合周期巡检和批处理。",
        "巡检任务把读取、判断、写入拆开，写入步骤再串审批。",
        "每次运行记录 cursor / lastSync / runId，方便重试和排错。",
      ],
      actions: [
        { label: "精确定时", example: "cron: 每天 09:00 汇总邮件与日历" },
        { label: "周期巡检", example: "heartbeat: 每 5 分钟检查未读邮件并归类" },
      ],
    },
    {
      id: "files",
      title: "本地文件管理",
      short: "Local Files",
      area: "core tool group:fs",
      status: "core",
      summary: "本地文件优先用内建 group:fs（read/write/edit/apply_patch），不通过 skill 绕路。",
      tips: [
        "文件操作前先 read，再做最小修改，减少覆盖风险。",
        "结构化文件（JSON/YAML）尽量走 patch 或精确更新，不要全量重写。",
        "高风险写操作前可以先输出 diff 或草稿内容供确认。",
      ],
      actions: [
        { label: "读文件", example: "read(path)" },
        { label: "补丁编辑", example: "apply_patch(...)" },
      ],
    },
    {
      id: "lobster",
      title: "审批工作流",
      short: "Lobster",
      area: "workflow orchestration",
      status: "ready",
      summary: "多步写操作（发邮件、更新文档、改日历）尽量走 Lobster，获得审批、恢复、可追踪能力。",
      tips: [
        "把不可逆动作放在最后一步，并在前一步展示待执行内容。",
        "把幂等键和业务 ID 带进工作流上下文，防止重放。",
        "先做一个最小模板（draft -> approve -> send），再逐步扩展条件分支。",
      ],
      actions: [
        {
          label: "邮件审批模板",
          example: "extensions/my-ops/workflows/mail-reply-approval.template.lobster.yaml",
        },
      ],
    },
  ];

  return items.map((item) => {
    if (item.status === "ready") {
      return { ...item, statusText: "已就绪", statusClass: "ready" };
    }
    if (item.status === "adapter") {
      return { ...item, statusText: "待接入 Adapter", statusClass: "warn" };
    }
    if (item.status === "core") {
      return { ...item, statusText: "核心能力", statusClass: "ready" };
    }
    return { ...item, statusText: "规划中", statusClass: "muted" };
  });
}

function renderGuideHtml(api: OpenClawPluginApi): string {
  const items = getGuideItems(api);
  const generatedAt = new Date().toISOString();
  const guideDataJson = escapeJsonForScript(items);
  const hints = escapeHtml(renderGuideLinkHintsText());

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>My Ops 导航页</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f5f7;
      --panel: rgba(255,255,255,.88);
      --panel-strong: #ffffff;
      --ink: #162034;
      --muted: #65708a;
      --line: rgba(22,32,52,.10);
      --accent: #1f7a62;
      --accent-2: #0d5d85;
      --accent-soft: rgba(31,122,98,.10);
      --warn: #b26018;
      --warn-soft: rgba(178,96,24,.12);
      --radius: 18px;
      --shadow: 0 12px 36px rgba(18, 30, 48, .08);
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background:
        radial-gradient(circle at 10% 0%, rgba(13,93,133,.10), transparent 45%),
        radial-gradient(circle at 90% 10%, rgba(31,122,98,.12), transparent 40%),
        var(--bg);
      color: var(--ink);
      font-family: "Avenir Next", "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
      min-height: 100%;
    }
    a { color: inherit; }
    .wrap {
      max-width: 1180px;
      margin: 0 auto;
      padding: 20px 16px 28px;
    }
    .hero {
      position: relative;
      overflow: hidden;
      border-radius: 22px;
      padding: 18px 18px 14px;
      background:
        linear-gradient(140deg, rgba(31,122,98,.12), rgba(13,93,133,.08)),
        var(--panel);
      border: 1px solid var(--line);
      backdrop-filter: blur(8px);
      box-shadow: var(--shadow);
      margin-bottom: 14px;
    }
    .hero h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.15;
      letter-spacing: .01em;
    }
    .hero p {
      margin: 8px 0 0;
      color: var(--muted);
      line-height: 1.45;
      font-size: 14px;
    }
    .chip-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .chip {
      border: 1px solid var(--line);
      background: rgba(255,255,255,.75);
      color: var(--ink);
      border-radius: 999px;
      padding: 8px 10px;
      font-size: 12px;
      text-decoration: none;
      cursor: pointer;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr);
      gap: 14px;
      align-items: start;
    }
    .panel {
      border-radius: var(--radius);
      border: 1px solid var(--line);
      background: var(--panel);
      backdrop-filter: blur(8px);
      box-shadow: var(--shadow);
    }
    .cards {
      padding: 12px;
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
    }
    .search {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px 0;
    }
    .search input {
      width: 100%;
      border: 1px solid var(--line);
      background: var(--panel-strong);
      border-radius: 12px;
      padding: 10px 12px;
      font-size: 14px;
      outline: none;
      color: var(--ink);
    }
    .card {
      width: 100%;
      text-align: left;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: var(--panel-strong);
      padding: 12px;
      cursor: pointer;
      transition: transform .12s ease, border-color .12s ease, box-shadow .12s ease;
      box-shadow: 0 1px 0 rgba(0,0,0,.02);
    }
    .card:hover { transform: translateY(-1px); }
    .card.active {
      border-color: rgba(31,122,98,.36);
      box-shadow: 0 0 0 3px rgba(31,122,98,.10);
    }
    .card-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    .card h3 {
      margin: 0;
      font-size: 16px;
      line-height: 1.2;
    }
    .card small {
      display: block;
      margin-top: 3px;
      color: var(--muted);
      font-size: 12px;
    }
    .badge {
      flex: 0 0 auto;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 11px;
      border: 1px solid transparent;
      white-space: nowrap;
    }
    .badge.ready {
      color: var(--accent);
      background: var(--accent-soft);
      border-color: rgba(31,122,98,.16);
    }
    .badge.warn {
      color: var(--warn);
      background: var(--warn-soft);
      border-color: rgba(178,96,24,.16);
    }
    .badge.muted {
      color: var(--muted);
      background: rgba(101,112,138,.10);
      border-color: rgba(101,112,138,.12);
    }
    .card p {
      margin: 10px 0 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }
    .detail {
      padding: 14px;
      position: sticky;
      top: 12px;
    }
    .detail-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
    }
    .detail h2 {
      margin: 0;
      font-size: 22px;
      line-height: 1.15;
    }
    .detail .sub {
      margin-top: 4px;
      font-size: 13px;
      color: var(--muted);
    }
    .detail .summary {
      margin: 12px 0 12px;
      padding: 12px;
      border-radius: 14px;
      background: rgba(255,255,255,.7);
      border: 1px solid var(--line);
      line-height: 1.5;
      font-size: 14px;
    }
    .section-title {
      margin: 10px 0 8px;
      font-size: 13px;
      letter-spacing: .04em;
      color: var(--muted);
      text-transform: uppercase;
    }
    .tips {
      display: grid;
      gap: 8px;
      margin-bottom: 12px;
    }
    details.tip {
      border: 1px solid var(--line);
      background: rgba(255,255,255,.78);
      border-radius: 12px;
      padding: 8px 10px;
    }
    details.tip summary {
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
      list-style: none;
    }
    details.tip summary::-webkit-details-marker { display: none; }
    details.tip p {
      margin: 8px 0 0;
      color: var(--muted);
      line-height: 1.45;
      font-size: 13px;
    }
    .action {
      border: 1px solid var(--line);
      background: rgba(255,255,255,.78);
      border-radius: 12px;
      padding: 10px;
      margin-bottom: 8px;
    }
    .action-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
    }
    .action-head strong {
      font-size: 13px;
    }
    .action-head button {
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 999px;
      padding: 4px 9px;
      font-size: 11px;
      cursor: pointer;
      color: var(--ink);
    }
    pre {
      margin: 0;
      padding: 10px;
      border-radius: 10px;
      background: #10151f;
      color: #d7e3f7;
      font-size: 12px;
      overflow: auto;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .footer-note {
      margin-top: 12px;
      font-size: 12px;
      color: var(--muted);
      border-top: 1px dashed var(--line);
      padding-top: 10px;
      white-space: pre-wrap;
    }
    .meta {
      margin-top: 8px;
      font-size: 11px;
      color: var(--muted);
    }
    @media (max-width: 920px) {
      .layout {
        grid-template-columns: 1fr;
      }
      .detail {
        position: static;
      }
      .hero h1 {
        font-size: 20px;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <h1>My Ops 常用功能导航</h1>
      <p>给 /new 和 /reset 的引导入口用。把常用能力做成固定入口，降低 skill 驱动工作流的随机性。</p>
      <div id="chips" class="chip-row"></div>
    </section>

    <section class="layout">
      <div class="panel">
        <div class="search">
          <input id="search" type="search" placeholder="搜索功能 / 关键字（例如 邮件、日历、lobster）" />
        </div>
        <div id="cards" class="cards"></div>
      </div>

      <aside class="panel detail" id="detail"></aside>
    </section>
  </div>

  <script>
    const GUIDE_ITEMS = ${guideDataJson};
    const GUIDE_HINTS = ${JSON.stringify(hints)};
    const cardsEl = document.getElementById("cards");
    const chipsEl = document.getElementById("chips");
    const detailEl = document.getElementById("detail");
    const searchEl = document.getElementById("search");
    let filtered = GUIDE_ITEMS.slice();
    let activeId = (location.hash || "").replace(/^#/, "") || (GUIDE_ITEMS[0] && GUIDE_ITEMS[0].id);

    function iconFor(item) {
      const map = {
        mail: "✉︎",
        calendar: "◴",
        mowen: "✎",
        feishu: "文",
        schedule: "⏱",
        files: "⌘",
        lobster: "✓"
      };
      return map[item.id] || "•";
    }

    function renderChips(items) {
      chipsEl.innerHTML = "";
      items.forEach((item) => {
        const a = document.createElement("a");
        a.href = "#" + item.id;
        a.className = "chip";
        a.textContent = iconFor(item) + " " + item.title;
        a.addEventListener("click", (e) => {
          e.preventDefault();
          setActive(item.id, true);
        });
        chipsEl.appendChild(a);
      });
    }

    function renderCards() {
      cardsEl.innerHTML = "";
      if (filtered.length === 0) {
        const empty = document.createElement("div");
        empty.className = "card";
        empty.innerHTML = "<p>没有匹配项，换个关键词试试。</p>";
        cardsEl.appendChild(empty);
        return;
      }
      filtered.forEach((item) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "card" + (item.id === activeId ? " active" : "");
        btn.setAttribute("aria-pressed", item.id === activeId ? "true" : "false");
        btn.innerHTML = [
          '<div class="card-top">',
          '<div>',
          "<h3>" + item.title + "</h3>",
          "<small>" + item.area + " · " + item.short + "</small>",
          "</div>",
          '<span class="badge ' + item.statusClass + '">' + item.statusText + "</span>",
          "</div>",
          "<p>" + item.summary + "</p>"
        ].join("");
        btn.addEventListener("click", () => setActive(item.id, true));
        cardsEl.appendChild(btn);
      });
    }

    function buildTip(index, text) {
      const details = document.createElement("details");
      details.className = "tip";
      if (index === 0) {
        details.open = true;
      }
      const summary = document.createElement("summary");
      summary.textContent = "技巧 " + (index + 1);
      const p = document.createElement("p");
      p.textContent = text;
      details.appendChild(summary);
      details.appendChild(p);
      return details;
    }

    async function copyText(text, btn) {
      try {
        await navigator.clipboard.writeText(text);
        const prev = btn.textContent;
        btn.textContent = "已复制";
        setTimeout(() => { btn.textContent = prev; }, 1200);
      } catch {
        const prev = btn.textContent;
        btn.textContent = "复制失败";
        setTimeout(() => { btn.textContent = prev; }, 1200);
      }
    }

    function renderDetail() {
      const item = GUIDE_ITEMS.find((it) => it.id === activeId) || filtered[0] || GUIDE_ITEMS[0];
      if (!item) {
        detailEl.innerHTML = "<div>暂无内容</div>";
        return;
      }
      activeId = item.id;
      const root = document.createElement("div");

      const head = document.createElement("div");
      head.className = "detail-head";
      head.innerHTML = [
        "<div>",
        "<h2>" + item.title + "</h2>",
        '<div class="sub">' + item.area + " · " + item.short + "</div>",
        "</div>",
        '<span class="badge ' + item.statusClass + '">' + item.statusText + "</span>"
      ].join("");
      root.appendChild(head);

      const summary = document.createElement("div");
      summary.className = "summary";
      summary.textContent = item.summary;
      root.appendChild(summary);

      const tipsTitle = document.createElement("div");
      tipsTitle.className = "section-title";
      tipsTitle.textContent = "Usage Tips";
      root.appendChild(tipsTitle);

      const tipsWrap = document.createElement("div");
      tipsWrap.className = "tips";
      item.tips.forEach((tip, i) => tipsWrap.appendChild(buildTip(i, tip)));
      root.appendChild(tipsWrap);

      const actionsTitle = document.createElement("div");
      actionsTitle.className = "section-title";
      actionsTitle.textContent = "Quick Starts";
      root.appendChild(actionsTitle);

      item.actions.forEach((action) => {
        const block = document.createElement("div");
        block.className = "action";

        const head = document.createElement("div");
        head.className = "action-head";
        const title = document.createElement("strong");
        title.textContent = action.label;
        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.textContent = "复制";
        copyBtn.addEventListener("click", () => copyText(action.example, copyBtn));
        head.appendChild(title);
        head.appendChild(copyBtn);

        const pre = document.createElement("pre");
        pre.textContent = action.example;
        block.appendChild(head);
        block.appendChild(pre);
        root.appendChild(block);
      });

      const footer = document.createElement("div");
      footer.className = "footer-note";
      footer.textContent = GUIDE_HINTS
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
      root.appendChild(footer);

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = "Generated at ${generatedAt} · Path: ${MY_OPS_GUIDE_PATH}";
      root.appendChild(meta);

      detailEl.innerHTML = "";
      detailEl.appendChild(root);
      renderCards();
    }

    function setActive(id, pushHash) {
      if (!GUIDE_ITEMS.some((item) => item.id === id)) {
        return;
      }
      activeId = id;
      if (pushHash) {
        history.replaceState(null, "", "#" + id);
      }
      renderDetail();
    }

    function applySearch() {
      const q = (searchEl.value || "").trim().toLowerCase();
      filtered = GUIDE_ITEMS.filter((item) => {
        if (!q) return true;
        const hay = [
          item.id,
          item.title,
          item.short,
          item.area,
          item.summary,
          ...item.tips,
          ...item.actions.map((a) => a.label + " " + a.example)
        ].join("\\n").toLowerCase();
        return hay.includes(q);
      });
      if (!filtered.some((item) => item.id === activeId) && filtered[0]) {
        activeId = filtered[0].id;
      }
      renderCards();
      renderDetail();
    }

    window.addEventListener("hashchange", () => {
      const next = (location.hash || "").replace(/^#/, "");
      if (next) {
        setActive(next, false);
      }
    });

    searchEl.addEventListener("input", applySearch);
    renderChips(GUIDE_ITEMS);
    renderCards();
    renderDetail();
  </script>
</body>
</html>`;
}

export function renderGuideLinkHintsText(): string {
  return [
    "常用功能导航（H5）:",
    `- ${MY_OPS_GUIDE_PATH}`,
    `- 邮件：${MY_OPS_GUIDE_PATH}#mail`,
    `- 日历：${MY_OPS_GUIDE_PATH}#calendar`,
    `- 墨问：${MY_OPS_GUIDE_PATH}#mowen`,
    `- 飞书：${MY_OPS_GUIDE_PATH}#feishu`,
    "",
    "提示：在 OpenClaw Web 控制台可直接打开相对路径；在 Telegram/飞书等渠道请把路径拼到你的网关地址后面。",
  ].join("\n");
}

export function renderGuideMenuText(): string {
  return [
    "┌─ My Ops 常用功能菜单 ─┐",
    "│ 1) 邮件管理（Himalaya / ops_mail）",
    "│    技巧：先 health / list，再做分类、草拟、发送",
    "│    常用动作：list_messages / get_message / draft_reply / send_message",
    "│    发送要求：send_message 必带 idempotencyKey（建议先 draft 再发）",
    "│    常用命令：/ops mail summary /ops mail junk list /ops mail junk clear --dry-run",
    "│",
    "│ 2) 日历管理（ops_calendar）",
    "│    技巧：先查今天/本周，再建事件或改提醒",
    "│    常用命令：/ops calendar calendars /ops calendar today /ops calendar week",
    "│    写操作：/ops calendar create|update|delete（delete 默认预览，需 --confirm）",
    "│",
    "│ 3) 墨问（ops_mowen）",
    "│    技巧：用 create_doc / update_doc / set_doc（无 list/get）",
    "│    常用命令：/ops mowen fetch|post|edit（支持飞书 docx/wiki）",
    "│    例子：/ops mowen post <飞书链接> --private",
    "│",
    "│ 4) 飞书文档（feishu 插件）",
    "│    技巧：先整理草稿，再写入文档",
    "│",
    "│ 5) 定时任务（cron / heartbeat）",
    "│    技巧：cron 做定时，heartbeat 做巡检",
    "│",
    "│ 6) 审批工作流（Lobster）",
    "│    技巧：写操作走 draft -> approve -> execute",
    "└──────────────────────┘",
    "",
    "快捷命令",
    "- /ops status    查看适配器状态（mail/calendar/mowen 是否已接好）",
    "- /ops calendar help 查看日历托底命令（今天/本周/创建/更新/删除）",
    "- /ops mail help 查看邮件托底命令（多邮箱汇总 / 垃圾邮件清理）",
    "- /ops mowen help 查看墨问托底命令（fetch/post/edit，支持飞书 docx/wiki）",
    "- /ops guide     查看 H5 导航入口（适合在 Web 控制台打开）",
    "- /status        查看当前模型与会话状态",
    "",
    "你也可以直接发一句话开始：",
    "- “先帮我看一下今天日历”",
    "- “列出最近 10 封未读邮件并按优先级分类”",
    "- “把这段内容发成墨问私有文章（直接发布）”",
  ].join("\n");
}

function buildResetGuideMessage(action: string): string {
  const commandName = action === "reset" ? "/reset" : "/new";
  return [
    `${commandName} 已触发。下面是你的常用功能菜单（移动端可直接照着发需求）：`,
    renderGuideMenuText(),
  ].join("\n");
}

export function registerMyOpsGuide(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    path: MY_OPS_GUIDE_PATH,
    handler: (_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(renderGuideHtml(api));
    },
  });

  api.registerHook(
    ["command:new", "command:reset"],
    (event) => {
      event.suppressDefaultResetPrompt = true;
      event.messages.push(buildResetGuideMessage(event.action));
    },
    {
      name: "my-ops-reset-guide",
      description: "Inject my-ops H5 onboarding links for /new and /reset.",
    },
  );
}
