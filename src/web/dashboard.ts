import { createServer, type Server as HttpServer } from 'node:http';
import Database from 'better-sqlite3';
import QRCode from 'qrcode';
import {
  loadSettings,
  saveSettings,
  applySettings,
  type EditableConfig,
  REQUIRES_RESTART,
} from '../utils/settings.js';

export interface WebDashboardOptions {
  db: Database.Database;
  port?: number;
  host?: string;
}

export interface SessionState {
  connected: boolean;
  phone: string | null;
  /** Código de emparelhamento (QR) emitido pelo Baileys. */
  qr: string | null;
}

/** Dashboard local do WhatsApp Reminder Bot. Expõe métricas do banco e
 *  estado da sessão WhatsApp via HTTP. Tema escuro com animações leves. */
export function createWebDashboard(opts: WebDashboardOptions) {
  const { db, port = 3333, host = '127.0.0.1' } = opts;
  const state: SessionState = { connected: false, phone: null, qr: null };
  let server: HttpServer | null = null;

  // ---------- Estado da sessão (atualizado pelo cliente WhatsApp) ----------

  function setConnected(phone: string | null): void {
    state.connected = true;
    state.phone = phone;
    state.qr = null;
  }

  function setDisconnected(): void {
    state.connected = false;
    state.phone = null;
    state.qr = null;
  }

  function setQr(qr: string): void {
    state.qr = qr;
    state.connected = false;
    state.phone = null;
  }

  async function qrDataUrl(): Promise<string | null> {
    if (!state.qr) return null;
    try {
      const svg = await QRCode.toString(state.qr, {
        type: 'svg',
        margin: 1,
        width: 320,
        color: { dark: '#0f172a', light: '#ffffff' },
      });
      return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    } catch {
      return null;
    }
  }

  // ---------- Helpers de resposta ----------

  function sendJson(res: any, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
    });
    res.end(payload);
  }

  function sendHtml(res: any, html: string): void {
    const buffer = Buffer.from(html, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buffer.length,
      'Cache-Control': 'no-store',
    });
    res.end(buffer);
  }

  // ---------- Métricas do banco de dados ----------

  function metricsHandler(res: any): void {
    const now = Date.now();
    const oneHourMs = 60 * 60 * 1000;

    const safe = <T>(fn: () => T, fallback: T): T => {
      try {
        return fn();
      } catch {
        return fallback;
      }
    };

    const users = safe(
      () =>
        db
          .prepare('SELECT count(*) AS c FROM users')
          .get() as { c: number },
      { c: 0 },
    ).c;

    let reminders: {
      total: number;
      pending: number;
      completed: number;
      cancelled: number;
    };
    try {
      const rows = safe(
        () =>
          db
            .prepare('SELECT status, count(*) AS c FROM reminders GROUP BY status')
            .all() as Array<{ status: string; c: number }>,
        [],
      );
      const byStatus: Record<string, number> = {
        pending: 0,
        completed: 0,
        cancelled: 0,
      };
      for (const row of rows) byStatus[row.status] = row.c;
      reminders = {
        total: byStatus.pending + byStatus.completed + byStatus.cancelled,
        pending: byStatus.pending,
        completed: byStatus.completed,
        cancelled: byStatus.cancelled,
      };
    } catch {
      reminders = { total: 0, pending: 0, completed: 0, cancelled: 0 };
    }

    const dueSoon = safe(
      () =>
        db
          .prepare(
            "SELECT count(*) AS c FROM reminders WHERE status = 'pending' AND trigger_at <= ?",
          )
          .get(now + oneHourMs) as { c: number },
      { c: 0 },
    ).c;

    let deliveries: {
      total: number;
      sending: number;
      delivered: number;
      failed: number;
    };
    try {
      const rows = safe(
        () =>
          db
            .prepare('SELECT status, count(*) AS c FROM delivery_log GROUP BY status')
            .all() as Array<{ status: string; c: number }>,
        [],
      );
      const byStatus: Record<string, number> = {
        sending: 0,
        delivered: 0,
        failed: 0,
      };
      for (const row of rows) byStatus[row.status] = row.c;
      deliveries = {
        total: byStatus.sending + byStatus.delivered + byStatus.failed,
        sending: byStatus.sending,
        delivered: byStatus.delivered,
        failed: byStatus.failed,
      };
    } catch {
      deliveries = { total: 0, sending: 0, delivered: 0, failed: 0 };
    }

    const recent = safe(
      () =>
        db.prepare(
          `SELECT dl.reminder_id, r.message, dl.status, dl.delivered_at, dl.whatsapp_msg_id
           FROM delivery_log dl
           LEFT JOIN reminders r ON r.id = dl.reminder_id
           ORDER BY dl.delivered_at DESC
           LIMIT 10`,
        ).all() as Array<{
          reminder_id: string;
          message: string | null;
          status: string;
          delivered_at: number;
          whatsapp_msg_id: string | null;
        }>,
      [],
    );

    sendJson(res, 200, {
      users,
      reminders,
      dueSoon,
      deliveries,
      recent,
      generatedAt: now,
    });
  }

  // ---------- Servidor HTTP ----------

  async function requestListener(req: any, res: any): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    const { pathname } = url;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method !== 'GET' && !(req.method === 'PUT' && pathname === '/api/config')) {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    if (pathname === '/') {
      sendHtml(res, buildHtml(host, port));
      return;
    }

    if (pathname === '/api/metrics') {
      metricsHandler(res);
      return;
    }

    if (pathname === '/api/session') {
      sendJson(res, 200, {
        connected: state.connected,
        phone: state.phone,
        qrDataUrl: await qrDataUrl(),
      });
      return;
    }

    if (pathname === '/api/qr.svg') {
      const svg = await qrDataUrl();
      if (!svg) {
        sendJson(res, 404, { error: 'qr indisponível' });
        return;
      }
      // data:image/svg+xml -> extrair o markup para servir como imagem
      const markup = svg.replace(/^data:image\/svg\+xml;utf8,/, '');
      const buffer = Buffer.from(decodeURIComponent(markup), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Content-Length': buffer.length,
        'Cache-Control': 'no-store',
      });
      res.end(buffer);
      return;
    }

    if (pathname === '/api/config' && req.method === 'GET') {
      const settings = loadSettings();
      sendJson(res, 200, {
        ...settings,
        requiresRestartKeys: REQUIRES_RESTART,
      });
      return;
    }

    if (pathname === '/api/config' && req.method === 'PUT') {
      let body = '';
      for await (const chunk of req) {
        body += chunk as string;
      }
      let patch: Partial<EditableConfig>;
      try {
        patch = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: 'json invalido' });
        return;
      }
      const { saved, requiresRestart } = applySettings(patch);
      sendJson(res, 200, {
        ok: true,
        saved,
        requiresRestart,
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  function start(): Promise<void> {
    return new Promise((resolve, reject) => {
      server = createServer(requestListener);
      server.listen(port, host, () => {
        resolve();
      });
      server.on('error', reject);
    });
  }

  function stop(): void {
    server?.close();
    server = null;
  }

  const url = () => `http://${host}:${port}`;

  return {
    start,
    stop,
    url,
    setConnected,
    setDisconnected,
    setQr,
  };
}

function buildHtml(host: string, port: number): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Painel local do WhatsApp Reminder Bot — métricas, sessão e configurações">
<meta name="theme-color" content="#0b0d12">
<title>Reminder Bot — Painel</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0b0d12;
    --surface: #111318;
    --surface-hover: #181c24;
    --border: #232935;
    --fg: #e8eaed;
    --fg-muted: #a8b0b8;
    --fg-dim: #8b93a1;
    --accent: #3b82f6;
    --accent-hover: #60a5fa;
    --success: #22c55e;
    --success-dim: #16a34a;
    --danger: #ef4444;
    --warn: #f59e0b;
    --shadow: 0 8px 24px rgba(0,0,0,0.35);
    --radius: 12px;
    --space-xs: 8px;
    --space-sm: 12px;
    --space-md: 20px;
    --space-lg: 32px;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  html {
    background: var(--bg);
    color: var(--fg);
    font-family: 'Inter', system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    line-height: 1.5;
  }

  body {
    background: var(--bg);
    min-height: 100vh;
  }

  ::selection { background: rgba(59,130,246,0.35); }

  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .container { max-width: 1000px; margin: 0 auto; padding: 0 var(--space-md); overflow-x: hidden; }

  /* Header */
  header {
    padding: var(--space-lg) 0 var(--space-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
  }

  .mark {
    width: 32px; height: 32px;
    border-radius: 8px;
    background: linear-gradient(135deg, var(--accent), #1d4ed8);
    display: grid; place-items: center;
    font-weight: 700; font-family: 'JetBrains Mono', monospace; font-size: 14px;
    color: var(--fg);
    box-shadow: 0 4px 14px rgba(59,130,246,0.35);
  }

  h1 { font-size: clamp(1.5rem, 2vw, 1.75rem); font-weight: 600; letter-spacing: -0.02em; }
  h1 span { color: var(--fg-muted); font-weight: 400; }

  .url-bar {
    display: flex; align-items: center; gap: var(--space-sm);
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: var(--space-sm) var(--space-md);
    font-family: 'JetBrains Mono', monospace; font-size: 13px; color: var(--fg-muted);
  }
  .url-bar b { color: var(--accent); }
  .url-btn {
    margin-left: auto; background: transparent; border: 1px solid var(--border);
    color: var(--fg); padding: 4px 10px; border-radius: 6px; font-size: 12px;
    cursor: pointer; transition: background 0.15s, border-color 0.15s;
  }
  .url-btn:hover { background: var(--surface-hover); border-color: var(--accent); }

  /* Status */
  .status-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: var(--space-md);
  }

  .pill {
    display: inline-flex; align-items: center; gap: var(--space-sm);
    padding: 6px 12px; border-radius: 999px; font-size: 12.5px; font-weight: 600;
    border: 1px solid; letter-spacing: -0.01em;
  }
  .pill.connected { background: rgba(34,197,94,0.12); color: var(--success-dim); border-color: rgba(34,197,94,0.25); }
  .pill.disconnected { background: rgba(239,68,68,0.12); color: var(--danger); border-color: rgba(239,68,68,0.25); }
  .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: currentColor; opacity: 0.85;
  }
  .dot.pulse { animation: pulse 2s infinite; }

  /* Grid de métricas */
  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--space-md);
    margin-top: var(--space-lg);
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-md);
    min-width: 0;
    transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
    opacity: 0; transform: translateY(16px); animation: fadeUp 0.6s ease forwards;
  }
  .card:nth-child(1) { animation-delay: 0.05s; }
  .card:nth-child(2) { animation-delay: 0.12s; }
  .card:nth-child(3) { animation-delay: 0.19s; }
  .card:nth-child(4) { animation-delay: 0.26s; }
  .card:nth-child(5) { animation-delay: 0.33s; }
  .card:hover { transform: translateY(-4px); border-color: var(--accent); box-shadow: var(--shadow); }

  .card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-sm); margin-bottom: var(--space-sm); flex-wrap: wrap; }
  .card-label { font-size: 12px; color: var(--fg-muted); font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-badge { font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 6px; background: rgba(0,0,0,0.25); color: var(--fg-dim); border: 1px solid rgba(255,255,255,0.06); flex-shrink: 0; }
  .card-badge.primary { color: var(--accent); border-color: rgba(59,130,246,0.25); background: rgba(59,130,246,0.10); }
  .card-badge.success { color: var(--success-dim); border-color: rgba(34,197,94,0.25); background: rgba(34,197,94,0.10); }
  .card-badge.danger { color: var(--danger); border-color: rgba(239,68,68,0.25); background: rgba(239,68,68,0.10); }

  .card-value {
    font-family: 'JetBrains Mono', monospace; font-size: 32px; font-weight: 700;
    letter-spacing: -0.03em; line-height: 1.1; margin-bottom: var(--space-sm);
    overflow-wrap: anywhere; word-break: break-word;
  }
  .card-value.small { font-size: 22px; }
  .card-note { font-size: 13px; color: var(--fg-muted); }

  /* Sessão */
  section { margin-top: var(--space-lg); }
  .section-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-sm); margin-bottom: var(--space-md); }
  .section-title { font-size: 16px; font-weight: 600; }
  .section-title b { color: var(--accent); }

  .session-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: var(--space-lg);
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--space-md);
    opacity: 0; transform: translateY(16px);
    animation: fadeUp 0.6s ease forwards 0.4s;
    animation-fill-mode: forwards;
  }

  .qrcode-wrap {
    border: 2px dashed var(--border); border-radius: var(--radius);
    padding: var(--space-lg); background: rgba(0,0,0,0.2);
    display: flex; flex-direction: column; align-items: center; gap: var(--space-sm);
    min-height: 260px; justify-content: center;
  }
  .qrcode-wrap img { max-width: 260px; max-height: 260px; width: 220px; height: 220px; display: block; border-radius: 8px; background: #fff; box-shadow: var(--shadow); animation: qrPop 0.5s ease backwards; animation-delay: 0.5s; }
  .qrcode-empty { color: var(--fg-muted); font-size: 14px; }

  /* Tabela de atividade */
  .table-wrap {
    border: 1px solid var(--border); border-radius: var(--radius);
    overflow: hidden; background: var(--surface);
    opacity: 0; transform: translateY(16px); animation: fadeUp 0.6s ease forwards 0.5s;
    animation-fill-mode: forwards;
    overflow-x: auto;
  }
  table { width: 100%; border-collapse: collapse; font-family: 'JetBrains Mono', monospace; font-size: 13px; }
  th, td { text-align: left; padding: 12px 16px; border-bottom: 1px solid var(--border); color: var(--fg); white-space: nowrap; }
  th { background: rgba(0,0,0,0.15); font-weight: 600; font-size: 11px; text-transform: uppercase; color: var(--fg-muted); letter-spacing: 0.05em; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(255,255,255,0.03); }
  .badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; border: 1px solid; }
  .badge.delivered { background: rgba(34,197,94,0.12); color: var(--success-dim); border-color: rgba(34,197,94,0.25); }
  .badge.failed { background: rgba(239,68,68,0.12); color: var(--danger); border-color: rgba(239,68,68,0.25); }
  .badge.sending { background: rgba(245,158,11,0.12); color: var(--warn); border-color: rgba(245,158,11,0.25); }

  .msg { font-family: 'Inter', sans-serif; font-size: 13px; color: var(--fg); max-width: 260px; }
  .msg-null { color: var(--fg-dim); }

  .footer {
    margin-top: var(--space-lg); padding: var(--space-md) 0;
    color: var(--fg-muted); font-size: 12.5px; text-align: center;
    border-top: 1px solid var(--border);
  }

  /* Animações */
  @keyframes fadeUp {
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }
  @keyframes qrPop {
    from { opacity: 0; transform: scale(0.9); }
    to { opacity: 1; transform: scale(1); }
  }

  .stale { color: var(--danger); font-size: 12px; font-weight: 600; }

  @media (max-width: 640px) {
    .status-row { flex-direction: column; align-items: flex-start; gap: var(--space-sm); }
    .session-card { padding: var(--space-md); }
    .qrcode-wrap img { width: 180px; height: 180px; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }

  /* Configuracoes */
  .config-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-md);
  }
  .config-field { display: flex; flex-direction: column; gap: var(--space-xs); }
  .config-field label { font-size: 12px; font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .config-field input {
    background: var(--bg); border: 1px solid var(--border); color: var(--fg);
    border-radius: var(--radius); padding: var(--space-sm) var(--space-md); font-family: 'JetBrains Mono', monospace; font-size: 13px;
  }
  .config-field input:focus { border-color: var(--accent); outline: none; }
  .config-field select {
    background: var(--bg); border: 1px solid var(--border); color: var(--fg);
    border-radius: var(--radius); padding: var(--space-sm) var(--space-md); font-family: 'JetBrains Mono', monospace; font-size: 13px; cursor: pointer;
  }
  .config-field select:focus { border-color: var(--accent); outline: none; }
  .config-hint { font-size: 11.5px; color: var(--fg-dim); margin-top: var(--space-xs); }
  .config-hint.restart { color: var(--warn); font-weight: 600; }
  .config-actions { display: flex; gap: var(--space-sm); margin-top: var(--space-md); }
  .config-btn {
    background: var(--accent); color: var(--fg); border: none; border-radius: var(--radius);
    padding: var(--space-sm) var(--space-lg); font-weight: 600; cursor: pointer;
    transition: background 0.18s, transform 0.1s;
  }
  .config-btn:hover { background: var(--accent-hover); }
  .config-btn:active { transform: scale(0.97); }
  .config-btn.secondary { background: var(--surface-hover); border: 1px solid var(--border); color: var(--fg); }
  .config-btn.secondary:hover { background: var(--border); }
  .config-saved { margin-left: var(--space-sm); font-size: 12px; color: var(--success-dim); font-weight: 600; animation: fadeIn 0.4s ease forwards; }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="brand">
      <div class="mark">RB</div>
      <div>
        <h1>Reminder Bot <span>· Painel local</span></h1>
      </div>
    </div>
    <div class="url-bar">
      <span>Servidor:</span> <b id="urlHost">${host}</b>:<b id="urlPort">${port}</b>
      <button class="url-btn" id="copyUrl">Copiar link</button>
    </div>
  </header>

  <div class="status-row">
    <div class="pill" id="statusPill">
      <span class="dot pulse" id="statusDot"></span>
      <span id="statusText">Iniciando sessão…</span>
    </div>
    <span id="updatedAt" style="font-size:12.5px;color:var(--fg-muted);font-family:'JetBrains Mono',monospace;"></span>
  </div>

  <div class="metrics-grid">
    <div class="card">
      <div class="card-head"><span class="card-label">Usuários</span><span class="card-badge">usuarios</span></div>
      <div class="card-value" id="mUsers">–</div>
      <div class="card-note">números cadastrados</div>
    </div>
    <div class="card">
      <div class="card-head"><span class="card-label">Pendentes</span><span class="card-badge primary">lembretes</span></div>
      <div class="card-value small" id="mPending">–</div>
      <div class="card-note">aguardando disparo</div>
    </div>
    <div class="card">
      <div class="card-head"><span class="card-label">Concluídos</span><span class="card-badge success">lembretes</span></div>
      <div class="card-value small" id="mCompleted">–</div>
      <div class="card-note">já disparados</div>
    </div>
    <div class="card">
      <div class="card-head"><span class="card-label">Entregas</span><span class="card-badge primary">delivery_log</span></div>
      <div class="card-value small" id="mDeliveries">–</div>
      <div class="card-note">registros de envio</div>
    </div>
    <div class="card">
      <div class="card-head"><span class="card-label">Devido em 1h</span><span class="card-badge warn">urgente</span></div>
      <div class="card-value small" id="mDueSoon">–</div>
      <div class="card-note">disparam na próxima hora</div>
    </div>
  </div>

  <section>
    <div class="section-head">
      <div class="section-title">Sessão WhatsApp <b id="sessionSubtitle">—</b></div>
    </div>
    <div class="session-card">
      <div>
        <div style="display:flex;align-items:center;gap:var(--space-sm);font-size:14px;">
          <span class="dot" id="waDot"></span>
          <span id="waText">Aguardando emparelhamento…</span>
        </div>
        <p id="waPhone" style="margin-top:6px;font-size:13px;color:var(--fg-muted);font-family:'JetBrains Mono',monospace;"></p>
      </div>
      <div class="qrcode-wrap" id="qrWrap">
        <img id="qrImg" alt="QR Code WhatsApp" style="display:none;">
        <p class="qrcode-empty" id="qrEmpty">Abra o WhatsApp &gt; Aparelhos conectados &gt; Conectar aparelho</p>
      </div>
    </div>
  </section>

  <section>
    <div class="section-head">
      <div class="section-title">Atividade recente <b id="activitySubtitle">—</b></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Lembrete</th><th>Mensagem</th><th>Status</th><th>Enviado em</th><th>Msg ID WhatsApp</th></tr>
        </thead>
        <tbody id="activityBody"></tbody>
      </table>
    </div>
  </section>

  <section>
    <div class="section-head">
      <div class="section-title">Configuracoes do bot</div>
    </div>
    <div class="session-card">
      <div class="config-grid">
        <div class="config-field">
          <label for="cfgTestPhone">Numero de teste</label>
          <input type="text" id="cfgTestPhone" placeholder="ex: 5511999999999">
          <p class="config-hint">Filtro TEST_PHONE_NUMBER. Aplica imediatamente.</p>
        </div>
        <div class="config-field">
          <label for="cfgDatabasePath">Caminho do banco</label>
          <input type="text" id="cfgDatabasePath" placeholder="reminder_bot.db">
          <p class="config-hint restart">Requer reinicializacao do bot.</p>
        </div>
        <div class="config-field">
          <label for="cfgLogLevel">Nivel de log</label>
          <select id="cfgLogLevel">
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
          <p class="config-hint">Aplica imediatamente.</p>
        </div>
        <div class="config-field">
          <label for="cfgNvidiaBaseUrl">NVIDIA Base URL</label>
          <input type="text" id="cfgNvidiaBaseUrl" placeholder="https://integrate.api.nvidia.com/v1">
          <p class="config-hint restart">Requer reinicializacao do bot.</p>
        </div>
        <div class="config-field">
          <label for="cfgNvidiaModel">NVIDIA Modelo</label>
          <input type="text" id="cfgNvidiaModel" placeholder="nvidia/nemotron-mini-4b-instruct">
          <p class="config-hint restart">Requer reinicializacao do bot.</p>
        </div>
      </div>
      <div class="config-actions">
        <button class="config-btn" id="cfgSave">Salvar configuracoes</button>
        <button class="config-btn secondary" id="cfgReload">Recarregar</button>
        <span id="cfgSaved" class="config-saved" style="display:none;">Salvo.</span>
      </div>
      <p id="cfgRestartNotice" class="config-hint restart" style="margin-top:var(--space-sm);display:none;">
        Algumas alteracoes requerem reinicializacao do bot para surtir efeito.
      </p>
    </div>
  </section>

  <div class="footer">
    Reminder Bot · Painel local exclusivo deste computador · <span id="refresh">Atualizando…</span>
  </div>
</div>

<script>
  const ENDPOINT_METRICS = '/api/metrics';
  const ENDPOINT_SESSION = '/api/session';
  let stale = false;

  function fmtMs(ms) {
    const d = new Date(ms);
    return d.toLocaleString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function relTime(ms) {
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 5) return 'agora';
    if (s < 60) return s + 's atrás';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm atrás';
    const h = Math.floor(m / 60);
    return h + 'h atrás';
  }

  function esc(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  function truncate(text, n = 70) {
    text = esc(text);
    return text.length > n ? text.slice(0, n - 1) + '…' : text;
  }

  async function load() {
    try {
      const [mRes, sRes] = await Promise.all([
        fetch(ENDPOINT_METRICS, { cache: 'no-store' }),
        fetch(ENDPOINT_SESSION, { cache: 'no-store' }),
      ]);
      if (!mRes.ok || !sRes.ok) throw new Error('endpoint error');
      const m = await mRes.json();
      const s = await sRes.json();

      stale = false;
      document.getElementById('mUsers').textContent = m.users ?? 0;
      document.getElementById('mPending').textContent = (m.reminders && m.reminders.pending) ?? 0;
      document.getElementById('mCompleted').textContent = (m.reminders && m.reminders.completed) ?? 0;
      document.getElementById('mDeliveries').textContent = (m.deliveries && m.deliveries.total) ?? 0;
      document.getElementById('mDueSoon').textContent = m.dueSoon ?? 0;
      document.getElementById('updatedAt').textContent = 'Atualizado ' + fmtMs(m.generatedAt ?? Date.now());

      const pill = document.getElementById('statusPill');
      const dot = document.getElementById('statusDot');
      const text = document.getElementById('statusText');
      const waDot = document.getElementById('waDot');
      const waText = document.getElementById('waText');
      const waPhone = document.getElementById('waPhone');
      const qrWrap = document.getElementById('qrWrap');
      const qrImg = document.getElementById('qrImg');
      const qrEmpty = document.getElementById('qrEmpty');
      const sessionSubtitle = document.getElementById('sessionSubtitle');
      const activityBody = document.getElementById('activityBody');

      if (s.connected) {
        pill.className = 'pill connected';
        dot.className = 'dot pulse';
        text.textContent = 'WhatsApp conectado';
        waDot.className = 'dot pulse';
        waText.textContent = 'Sessão ativa';
        waPhone.textContent = s.phone ? ('Telefone: ' + esc(s.phone)) : '';
        qrWrap.style.display = 'none';
        sessionSubtitle.textContent = '· conectado';
      } else if (s.qrDataUrl) {
        pill.className = 'pill disconnected';
        dot.className = 'dot';
        text.textContent = 'Aguardando emparelhamento';
        waDot.className = 'dot';
        waText.textContent = 'Sessão não conectada';
        waPhone.textContent = '';
        qrWrap.style.display = 'flex';
        qrImg.src = s.qrDataUrl;
        qrImg.style.display = 'block';
        qrEmpty.style.display = 'none';
        sessionSubtitle.textContent = '· escaneie o QR';
      } else {
        pill.className = 'pill disconnected';
        dot.className = 'dot';
        text.textContent = 'Sem QR disponível';
        waDot.className = 'dot';
        waText.textContent = 'Sessão não conectada';
        waPhone.textContent = '';
        qrWrap.style.display = 'flex';
        qrImg.src = '';
        qrImg.style.display = 'none';
        qrEmpty.style.display = 'block';
        sessionSubtitle.textContent = '· inicie o bot';
      }

      const rows = (m.recent || []).map((r) => {
        const statusCls = (r.status === 'delivered' ? 'delivered' : r.status === 'failed' ? 'failed' : 'sending');
        const msg = r.message ? truncate(r.message, 60) : '\u2014';
        const sent = r.delivered_at ? fmtMs(r.delivered_at) : '\u2014';
        const msgId = r.whatsapp_msg_id ? esc(r.whatsapp_msg_id) : '\u2014';
        return '<tr>' +
          '<td style="color:var(--fg-muted)">' + esc(r.reminder_id) + '</td>' +
          '<td class="msg">' + msg + '</td>' +
          '<td><span class="badge ' + statusCls + '">' + esc(r.status) + '</span></td>' +
          '<td style="color:var(--fg-muted)">' + sent + '</td>' +
          '<td style="color:var(--fg-muted)">' + msgId + '</td>' +
          '</tr>';
      }).join('');
      activityBody.innerHTML = rows || '<tr><td colspan="5" style="color:var(--fg-muted);text-align:center;padding:24px;">Sem atividade recente</td></tr>';

    } catch (err) {
      if (!stale) {
        stale = true;
        document.getElementById('statusText').textContent = 'Erro ao carregar métricas';
        document.getElementById('statusPill').className = 'pill disconnected';
        document.getElementById('updatedAt').textContent = 'Falha na atualização';
        console.error(err);
      }
    }
  }

  load();
  setInterval(load, 2500);

  const btn = document.getElementById('copyUrl');
  if (btn) {
    btn.addEventListener('click', async () => {
      const url = window.location.origin;
      try {
        await navigator.clipboard.writeText(url);
        const old = btn.textContent;
        btn.textContent = 'Copiado!';
        setTimeout(() => { btn.textContent = old; }, 1600);
      } catch {
        btn.textContent = 'Falha';
        setTimeout(() => { btn.textContent = 'Copiar link'; }, 1600);
      }
    });
  }

  /* ---------- Configuracoes ---------- */
  const ENDPOINT_CONFIG = '/api/config';

  function loadConfig() {
    fetch(ENDPOINT_CONFIG, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error('config error');
        return res.json();
      })
      .then((c) => {
        document.getElementById('cfgTestPhone').value = c.testPhoneNumber ?? '';
        document.getElementById('cfgDatabasePath').value = c.databasePath ?? '';
        document.getElementById('cfgLogLevel').value = c.logLevel ?? 'info';
        document.getElementById('cfgNvidiaBaseUrl').value = c.nvidiaBaseUrl ?? '';
        document.getElementById('cfgNvidiaModel').value = c.nvidiaModel ?? '';
        const notice = document.getElementById('cfgRestartNotice');
        if (c.requiresRestartKeys && c.requiresRestartKeys.length > 0) {
          notice.style.display = 'block';
        }
      })
      .catch((err) => {
        console.error('Falha ao carregar configuracoes:', err);
      });
  }

  function showSaved() {
    const el = document.getElementById('cfgSaved');
    el.style.display = 'inline';
    setTimeout(() => { el.style.display = 'none'; }, 2000);
  }

  const saveBtn = document.getElementById('cfgSave');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const patch = {
        testPhoneNumber: document.getElementById('cfgTestPhone').value.trim(),
        databasePath: document.getElementById('cfgDatabasePath').value.trim(),
        logLevel: document.getElementById('cfgLogLevel').value,
        nvidiaBaseUrl: document.getElementById('cfgNvidiaBaseUrl').value.trim(),
        nvidiaModel: document.getElementById('cfgNvidiaModel').value.trim(),
      };
      try {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Salvando…';
        const res = await fetch(ENDPOINT_CONFIG, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error('save error');
        const result = await res.json();
        showSaved();
        if (result.requiresRestart && result.requiresRestart.length > 0) {
          document.getElementById('cfgRestartNotice').style.display = 'block';
        }
      } catch (err) {
        console.error('Falha ao salvar configuracoes:', err);
        const old = saveBtn.textContent;
        saveBtn.textContent = 'Erro ao salvar';
        setTimeout(() => { saveBtn.textContent = old; }, 2000);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Salvar configuracoes';
      }
    });
  }

  const reloadBtn = document.getElementById('cfgReload');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', () => {
      window.location.reload();
    });
  }

  loadConfig();
</script>
</body>
</html>`;
}
