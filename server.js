/**
 * KICK QUIZ ARENA — Backend v3
 * Kick public API polling + WebSocket relay
 * OAuth veya webhook gerektirmez!
 */

const https = require('https');
const http  = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3001;

// { channelSlug -> { clients: Set<ws>, lastMsgId: null, polling: interval } }
const channels = new Map();

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, channels: [...channels.keys()], uptime: process.uptime() }));
    return;
  }
  res.writeHead(404); res.end('Not Found');
});

// ── WEBSOCKET SERVER ──────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let myChannel = null;
  console.log('[WS] Yeni frontend bağlandı');
  ws.send(JSON.stringify({ type: 'CONNECTED', message: 'Kick Quiz Arena Backend v3' }));

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'SUBSCRIBE') {
        const slug = (msg.channel || '').toLowerCase().trim();
        if (!slug) return;
        if (myChannel) leaveChannel(myChannel, ws);
        joinChannel(slug, ws);
        myChannel = slug;
      }
      if (msg.type === 'PING') ws.send(JSON.stringify({ type: 'PONG' }));
    } catch(e) {}
  });

  ws.on('close', () => { if (myChannel) leaveChannel(myChannel, ws); });
  ws.on('error', () => { if (myChannel) leaveChannel(myChannel, ws); });
});

// ── KANAL YÖNETİMİ ────────────────────────────────────────────────────────────
function joinChannel(slug, ws) {
  if (!channels.has(slug)) {
    channels.set(slug, { clients: new Set(), lastMsgId: null, polling: null });
    startPolling(slug);
  }
  const ch = channels.get(slug);
  ch.clients.add(ws);
  ws.send(JSON.stringify({
    type: 'SUBSCRIBED',
    channel: slug,
    message: `✅ "${slug}" kanalı dinleniyor! İzleyiciler A/B/C/D yazabilir.`
  }));
  console.log(`[Poll] #${slug} — ${ch.clients.size} client`);
}

function leaveChannel(slug, ws) {
  const ch = channels.get(slug);
  if (!ch) return;
  ch.clients.delete(ws);
  if (ch.clients.size === 0) {
    clearInterval(ch.polling);
    channels.delete(slug);
    console.log(`[Poll] #${slug} — boş, durduruldu`);
  }
}

function broadcast(slug, msg) {
  const ch = channels.get(slug);
  if (!ch) return;
  const json = JSON.stringify(msg);
  ch.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(json); });
}

// ── KICK PUBLIC API POLLING ───────────────────────────────────────────────────
function startPolling(slug) {
  const ch = channels.get(slug);
  if (!ch) return;
  console.log(`[Poll] #${slug} — başlıyor...`);

  getChatroomId(slug, (err, chatroomId) => {
    if (err) {
      console.error(`[Poll] #${slug} hata:`, err.message);
      broadcast(slug, { type: 'ERROR', message: `Kanal bulunamadı: "${slug}"` });
      return;
    }
    console.log(`[Poll] #${slug} chatroomId: ${chatroomId}`);

    // Başlangıç noktasını ayarla
    fetchMessages(chatroomId, (err, messages) => {
      if (!err && messages.length > 0) {
        const ch = channels.get(slug);
        if (ch) ch.lastMsgId = messages[messages.length - 1].id;
      }
    });

    // Her 2.5sn yeni mesaj kontrol et
    const interval = setInterval(() => {
      const ch = channels.get(slug);
      if (!ch) { clearInterval(interval); return; }

      fetchMessages(chatroomId, (err, messages) => {
        if (err || !messages.length) return;
        const ch = channels.get(slug);
        if (!ch) return;

        const lastId = ch.lastMsgId;
        const newMsgs = lastId ? messages.filter(m => m.id > lastId) : messages.slice(-1);

        if (newMsgs.length > 0) {
          ch.lastMsgId = newMsgs[newMsgs.length - 1].id;
          newMsgs.forEach(m => {
            const username = m.sender?.username || 'Anonim';
            const content  = m.content || '';
            const color    = m.sender?.identity?.color || null;
            if (!content) return;
            console.log(`[Chat] #${slug} | ${username}: ${content}`);
            broadcast(slug, { type: 'CHAT_MESSAGE', username, content, color, timestamp: Date.now() });
          });
        }
      });
    }, 2500);

    const ch2 = channels.get(slug);
    if (ch2) ch2.polling = interval;
  });
}

// ── KICK API ──────────────────────────────────────────────────────────────────
function getChatroomId(slug, cb) {
  kickGet(`/api/v2/channels/${encodeURIComponent(slug)}`, (err, data) => {
    if (err) return cb(err);
    const id = data?.chatroom?.id;
    if (!id) return cb(new Error('chatroom.id yok'));
    cb(null, id);
  });
}

function fetchMessages(chatroomId, cb) {
  kickGet(`/api/v2/channels/${chatroomId}/messages`, (err, data) => {
    if (err) return cb(err);
    const msgs = data?.data || data?.messages || [];
    cb(null, Array.isArray(msgs) ? msgs : []);
  });
}

function kickGet(path, cb) {
  const options = {
    hostname: 'kick.com',
    path,
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
      'Referer': 'https://kick.com',
      'Origin': 'https://kick.com'
    },
    timeout: 8000
  };
  const req = https.request(options, res => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      if (res.statusCode === 404) return cb(new Error('404'));
      if (res.statusCode !== 200) return cb(new Error(`HTTP ${res.statusCode}`));
      try { cb(null, JSON.parse(body)); } catch(e) { cb(new Error('JSON parse hatası')); }
    });
  });
  req.on('error', err => cb(err));
  req.on('timeout', () => { req.destroy(); cb(new Error('Timeout')); });
  req.end();
}

// ── BAŞLAT ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n✅ Kick Quiz Backend v3 — Port ${PORT} — Polling modu\n`);
});
