/**
 * KICK QUIZ ARENA — Backend Server
 *
 * Mimari:
 *   Kick (Webhook POST /webhook/kick) → bu server → WebSocket → Frontend
 *
 * Gereksinimler:
 *   - kick.com/settings/developer → App oluştur → Client ID & Secret al
 *   - Webhook URL: https://SENIN-DOMAIN.com/webhook/kick
 *   - Subscribed event: chat.message.sent
 *
 * Deploy: Railway / Render / Fly.io (ücretsiz tier yeterli)
 */

const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3001;

// ── ENV CONFIG ────────────────────────────────────────────────────────────────
// Railway/Render panelinden environment variable olarak ekle:
const KICK_CLIENT_ID     = process.env.KICK_CLIENT_ID     || '';
const KICK_CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || '';
const KICK_WEBHOOK_SECRET = process.env.KICK_WEBHOOK_SECRET || ''; // Kick dev panelinden

// Birden fazla yayıncı desteklemek için:  { channelSlug -> Set<WebSocket> }
const channelClients = new Map();

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health check
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
    return;
  }

  // ── KİCK WEBHOOK ENDPOINT ──────────────────────────────────────────────────
  if (req.url === '/webhook/kick' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      // İmza doğrulama (Kick resmi API imzası)
      if (KICK_WEBHOOK_SECRET) {
        const sig = req.headers['kick-event-signature'] || '';
        const msgId = req.headers['kick-event-message-id'] || '';
        const ts = req.headers['kick-event-message-timestamp'] || '';
        const expected = computeSignature(msgId, ts, body, KICK_WEBHOOK_SECRET);
        if (!safeCompare(sig, expected)) {
          console.warn('[Webhook] İmza doğrulama başarısız!');
          res.writeHead(401); res.end('Unauthorized'); return;
        }
      }

      try {
        const payload = JSON.parse(body);
        handleKickWebhook(payload);
      } catch (e) {
        console.error('[Webhook] Parse hatası:', e.message);
      }

      // Kick 200 bekler, yoksa retry yapar
      res.writeHead(200); res.end('OK');
    });
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

// ── WEBHOOK HANDLER ───────────────────────────────────────────────────────────
function handleKickWebhook(payload) {
  /*
    Kick webhook payload örneği (chat.message.sent):
    {
      "event": "chat.message.sent",
      "data": {
        "broadcaster": { "username": "yayinci", "channel_slug": "yayinci" },
        "sender": { "username": "izleyici", "identity": { "color": "#ff0000" } },
        "content": "A",
        "created_at": "2025-01-01T00:00:00Z"
      }
    }
  */
  const event = payload?.event;
  if (event !== 'chat.message.sent') return;

  const data = payload?.data || {};
  const channelSlug = data?.broadcaster?.channel_slug || data?.broadcaster?.username || '';
  const username = data?.sender?.username || 'Anonim';
  const content = data?.content || '';
  const color = data?.sender?.identity?.color || null;

  if (!channelSlug || !content) return;

  console.log(`[Chat] #${channelSlug} | ${username}: ${content}`);

  // Bu kanalı dinleyen tüm frontend'lere gönder
  broadcastToChannel(channelSlug.toLowerCase(), {
    type: 'CHAT_MESSAGE',
    username,
    content,
    color,
    timestamp: Date.now()
  });
}

function broadcastToChannel(slug, msg) {
  const clients = channelClients.get(slug);
  if (!clients) return;
  const json = JSON.stringify(msg);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  });
}

// ── WEBSOCKET SERVER (Frontend buraya bağlanır) ───────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  let subscribedChannel = null;
  console.log('[WS] Yeni bağlantı');

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'SUBSCRIBE') {
        const slug = (msg.channel || '').toLowerCase();
        if (!slug) return;

        // Eski kanaldan çık
        if (subscribedChannel) {
          const old = channelClients.get(subscribedChannel);
          if (old) { old.delete(ws); if (old.size === 0) channelClients.delete(subscribedChannel); }
        }

        // Yeni kanala kayıt
        if (!channelClients.has(slug)) channelClients.set(slug, new Set());
        channelClients.get(slug).add(ws);
        subscribedChannel = slug;

        ws.send(JSON.stringify({
          type: 'SUBSCRIBED',
          channel: slug,
          message: `✅ "${slug}" kanalı dinleniyor. İzleyiciler A/B/C/D yazabilir!`
        }));
        console.log(`[WS] Abone: #${slug} (toplam: ${channelClients.get(slug).size})`);
      }

      if (msg.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG' }));
      }

    } catch (e) { /* ignore */ }
  });

  ws.on('close', () => {
    if (subscribedChannel) {
      const clients = channelClients.get(subscribedChannel);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) channelClients.delete(subscribedChannel);
      }
    }
    console.log('[WS] Bağlantı kapandı');
  });

  ws.on('error', err => console.error('[WS] Hata:', err.message));

  // Bağlantı başarılı
  ws.send(JSON.stringify({ type: 'CONNECTED', message: 'Kick Quiz Arena Backend' }));
});

// ── İMZA YARDIMCI FONKSİYONLAR ───────────────────────────────────────────────
function computeSignature(msgId, timestamp, body, secret) {
  const data = msgId + timestamp + body;
  return 'sha256=' + crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function safeCompare(a, b) {
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
  catch (_) { return false; }
}

// ── BAŞLAT ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║     KICK QUIZ ARENA — Backend v2              ║');
  console.log(`║  HTTP/WS: http://0.0.0.0:${PORT}                 ║`);
  console.log('║  Webhook: POST /webhook/kick                  ║');
  console.log('╚═══════════════════════════════════════════════╝');
  console.log('');
  if (!KICK_CLIENT_ID) console.warn('⚠  KICK_CLIENT_ID env değişkeni ayarlanmamış');
  if (!KICK_WEBHOOK_SECRET) console.warn('⚠  KICK_WEBHOOK_SECRET ayarlanmamış (imza doğrulama kapalı)');
  console.log('Hazır. Kick webhook\'larını bekliyor...');
});
