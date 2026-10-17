// server.js
import express from 'express';
import WebSocket from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15000;

const LOOTLABS_HOSTS = new Set([
  'loot-link.com', 'loot-links.com', 'lootlink.org', 'lootlinks.co',
  'lootdest.info', 'lootdest.org', 'lootdest.com', 'links-loot.com',
  'linksloot.net', 'loot-reward.com', 'links.lootlabs.gg'
]);

const PLATOBOOST_HOSTS = new Set([
  'auth.platorelay.com', 'auth.platoboost.app', 'auth.platoboost.me',
  'auth.platoboost.net', 'auth.platoboost.click', 'gateway.platoboost.com'
]);

/**
 * LootLabs 5-byte rolling XOR decoder (matches nazarhktwitch/lootlabs-bypass & GreasyFork native decryptor).
 * First 5 bytes of base64-decoded buffer are the XOR key; remaining bytes are ciphertext.
 */
function decodeLootLabsXor(encodedStr, prefixLength = 5) {
  const clean = encodedStr.trim().replace(/^r:/, '');
  const raw = Buffer.from(clean, 'base64').toString('binary');
  if (raw.length <= prefixLength) {
    throw new Error('Ciphertext shorter than XOR prefix length');
  }
  const prefix = raw.slice(0, prefixLength);
  const payload = raw.slice(prefixLength);
  let out = '';
  for (let i = 0; i < payload.length; i++) {
    out += String.fromCharCode(payload.charCodeAt(i) ^ prefix.charCodeAt(i % prefixLength));
  }
  try {
    return decodeURIComponent(out);
  } catch {
    return out;
  }
}

/**
 * Decodes LootLabs &data= anti-bypass parameter if present on URL.
 */
function tryDecodeLootDataParam(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const dataParam = parsed.searchParams.get('data');
    if (dataParam) {
      const decoded = decodeLootLabsXor(dataParam, 5);
      if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
        return decoded;
      }
    }
  } catch {
    // Fall through to full WebSocket task emulation
  }
  return null;
}

async function timedFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(options.headers || {})
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extracts inline JS configuration variables from a LootLabs HTML page
 * and executes the /tc -> WSS -> /st -> /td handshake to receive the r:<cipher> link.
 */
async function bypassLootLabsNative(lootUrl, log) {
  log(`Checking LootLabs URL for direct &data= payload...`);
  const fastDecode = tryDecodeLootDataParam(lootUrl);
  if (fastDecode) {
    log(`Decoded &data= anti-bypass parameter directly via 5-byte XOR.`);
    return fastDecode;
  }

  log(`Fetching LootLabs gate page: ${lootUrl}`);
  const res = await timedFetch(lootUrl, { redirect: 'follow' });
  const html = await res.text();

  // Extract embedded task config variables from script tags
  const tidMatch = html.match(/p['tid']\s*=\s*(\d+)|tid\s*:\s*(\d+)|"tid"\s*:\s*(\d+)/i);
  const keyMatch = html.match(/KEY\s*=\s*["']([^"']+)["']|p['key']\s*=\s*["']([^"']+)["']/i);
  const syncerMatch = html.match(/INCENTIVE_SYNCER_DOMAIN\s*=\s*["']([^"']+)["']/i);
  const serverMatch = html.match(/INCENTIVE_SERVER_DOMAIN\s*=\s*["']([^"']+)["']/i);
  const pubLinkMatch = html.match(/PUBLISHER_LINK\s*=\s*["']([^"']+)["']/i);

  if (pubLinkMatch && pubLinkMatch[1]) {
    log(`Found pre-baked PUBLISHER_LINK in DOM, running 5-byte XOR decrypt...`);
    return decodeLootLabsXor(pubLinkMatch[1], 5);
  }

  const tid = tidMatch ? (tidMatch[1] || tidMatch[2] || tidMatch[3]) : null;
  const key = keyMatch ? (keyMatch[1] || keyMatch[2]) : null;
  const syncerDomain = syncerMatch ? syncerMatch[1] : 'nerventualken.com';
  const serverDomain = serverMatch ? serverMatch[1] : 'inkwize.net';

  if (!tid) {
    throw new Error('Could not locate LootLabs TID in page source (Cloudflare challenge or updated template)');
  }

  log(`Extracted LootLabs config: TID=${tid}, Syncer=${syncerDomain}, Server=${serverDomain}`);

  // Request task creation (/tc)
  const tcRes = await timedFetch(`https://${syncerDomain}/tc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': new URL(lootUrl).origin,
      'Referer': lootUrl
    },
    body: JSON.stringify({
      tid: Number(tid),
      bl: [1, 2, 3, 4, 5],
      session: crypto.randomUUID()
    })
  });

  if (!tcRes.ok) {
    throw new Error(`LootLabs /tc rejected with HTTP ${tcRes.status}`);
  }

  const tcData = await tcRes.json();
  const taskItem = Array.isArray(tcData) ? tcData[0] : tcData;
  if (!taskItem || !taskItem.urid) {
    throw new Error('LootLabs /tc response missing urid');
  }

  const urid = String(taskItem.urid);
  const taskId = taskItem.task_id || 54;
  const actionPixelUrl = taskItem.action_pixel_url;
  const shard = Number(urid.slice(-5)) % 3;
  const activeKey = key || taskItem.key || '1';

  log(`Minted task session: urid=${urid}, shard=${shard}, task_id=${taskId}`);

  // Connect to LootLabs incentive WebSocket and spoof completion beacons simultaneously
  const wsUrl = `wss://${shard}.${serverDomain}/c?uid=${urid}&cat=${taskId}&key=${activeKey}`;
  log(`Opening WebSocket: ${wsUrl}`);

  const encryptedPublisherLink = await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: {
        'User-Agent': UA,
        'Origin': new URL(lootUrl).origin
      }
    });

    let heartbeat = null;
    const timeout = setTimeout(() => {
      clearInterval(heartbeat);
      ws.terminate();
      reject(new Error('LootLabs WebSocket timed out waiting for r: frame'));
    }, 20000);

    ws.on('open', async () => {
      log(`WebSocket open. Sending heartbeat '0' and firing /st + /td beacons...`);
      ws.send('0');
      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('0');
      }, 1000);

      try {
        await timedFetch(`https://${shard}.${serverDomain}/st?uid=${urid}&cat=${taskId}`, {
          method: 'POST',
          headers: { 'Origin': new URL(lootUrl).origin, 'Referer': lootUrl }
        }).catch(() => {});

        if (actionPixelUrl) {
          const pxUrl = actionPixelUrl.startsWith('http') ? actionPixelUrl : `https:${actionPixelUrl}`;
          await timedFetch(pxUrl, { headers: { 'Referer': lootUrl } }).catch(() => {});
        }

        await timedFetch(`https://${syncerDomain}/td?ac=1&urid=${urid}&&cat=${taskId}&tid=${tid}`, {
          headers: { 'Origin': new URL(lootUrl).origin, 'Referer': lootUrl }
        }).catch(() => {});
      } catch (err) {
        log(`Beacon warning: ${err.message}`);
      }
    });

    ws.on('message', (data) => {
      const msg = data.toString();
      if (msg.startsWith('r:')) {
        clearInterval(heartbeat);
        clearTimeout(timeout);
        ws.close();
        resolve(msg.slice(2));
      }
    });

    ws.on('error', (err) => {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      reject(err);
    });
  });

  log(`Received encrypted r: frame (${encryptedPublisherLink.length} chars). Decrypting 5-byte XOR...`);
  const decryptedUrl = decodeLootLabsXor(encryptedPublisherLink, 5);
  log(`Decrypted destination: ${decryptedUrl}`);
  return decryptedUrl;
}

/**
 * Handles Platoboost / Platorelay (auth.platorelay.com/a?d=... or gateway.platoboost.com/a/id?id=...)
 * Extracts key if already whitelisted, or resolves the intermediate LootLabs/Linkvertise checkpoint.
 */
async function bypassPlatorelay(platoUrl, log) {
  const parsed = new URL(platoUrl);
  const dParam = parsed.searchParams.get('d');
  const legacyId = parsed.searchParams.get('id');
  const pathParts = parsed.pathname.split('/').filter(Boolean);

  log(`Inspecting Platorelay gateway: ${parsed.hostname}${parsed.pathname}`);

  // 1. Fetch the gateway page directly to check for existing FREE_ key or embedded session data
  const pageRes = await timedFetch(platoUrl, { redirect: 'follow' });
  const pageHtml = await pageRes.text();

  const existingKeyMatch = pageHtml.match(/(FREE_[a-f0-9]{24,40}|KEY_[a-zA-Z0-9_-]{10,})/i);
  if (existingKeyMatch) {
    log(`Found active key directly in Platorelay page response.`);
    return { type: 'key', result: existingKeyMatch[1], steps: [platoUrl] };
  }

  // 2. Legacy / v1 API gateway check: gateway.platoboost.com/a/<serviceId>?id=<ticket>
  if (legacyId && pathParts.length >= 2 && pathParts[0] === 'a') {
    const serviceId = pathParts[1];
    const authUrl = `https://api-gateway.platoboost.com/v1/authenticators/${serviceId}/${legacyId}`;
    log(`Querying Platoboost v1 authenticator: ${authUrl}`);
    const infoRes = await timedFetch(authUrl);
    if (infoRes.ok) {
      const info = await infoRes.json();
      if (info.key) {
        return { type: 'key', result: info.key, steps: [platoUrl] };
      }
      const sessionRes = await timedFetch(`https://api-gateway.platoboost.com/v1/sessions/auth/${serviceId}/${legacyId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': parsed.origin, 'Referer': platoUrl },
        body: JSON.stringify({ captcha: '' })
      });
      if (sessionRes.ok) {
        const sessionData = await sessionRes.json();
        if (sessionData.redirect) {
          log(`Platoboost issued ad-checkpoint redirect: ${sessionData.redirect}`);
          return await followCheckpointAndRedeem(sessionData.redirect, platoUrl, serviceId, legacyId, log);
        }
      }
    }
  }

  // 3. Modern auth.platorelay.com/a?d=... ticket resolution
  // Check if page HTML or Next.js/Nuxt payload contains a redirect link or session endpoint
  const adLinkMatch = pageHtml.match(/https?:\/\/(?:loot-link\.com|loot-links\.com|lootlink\.org|lootlinks\.co|lootdest\.org|lootdest\.com|loot-reward\.com|links\.lootlabs\.gg|linkvertise\.com)\/s\?[^\s"'<>\\]+/i);
  if (adLinkMatch) {
    const checkpointUrl = adLinkMatch[0];
    log(`Extracted embedded LootLabs checkpoint from Platorelay DOM: ${checkpointUrl}`);
    const callbackUrl = await bypassLootLabsNative(checkpointUrl, log);
    log(`Following callback URL back to Platorelay: ${callbackUrl}`);
    const finalRes = await timedFetch(callbackUrl, {
      headers: { 'Referer': checkpointUrl },
      redirect: 'follow'
    });
    const finalHtml = await finalRes.text();
    const finalKey = finalHtml.match(/(FREE_[a-f0-9]{24,40}|KEY_[a-zA-Z0-9_-]{10,})/i);
    return {
      type: finalKey ? 'key' : 'url',
      result: finalKey ? finalKey[1] : callbackUrl,
      checkpoint: checkpointUrl,
      callback: callbackUrl
    };
  }

  // 4. Multi-upstream API resolver fallback for Cloudflare Turnstile / encrypted d= tickets
  log(`Direct DOM scrape hit Turnstile/encrypted ticket (${dParam ? dParam.slice(0, 18) + '...' : 'no-d'}). Querying upstream bypass clusters...`);
  const upstreams = [
    {
      name: 'izen-cluster',
      url: `https://api.bypass.vip/bypass?url=${encodeURIComponent(platoUrl)}`,
      parse: (j) => j.result || j.destination || j.key
    },
    {
      name: 'solar-cluster',
      url: `https://api.solar-x.top/api/v3/bypass?url=${encodeURIComponent(platoUrl)}`,
      parse: (j) => j.result || j.key || j.data?.result
    },
    {
      name: 'ethos-cluster',
      url: `https://ethos-testing.vercel.app/api/bypass?url=${encodeURIComponent(platoUrl)}`,
      parse: (j) => j.result || j.key || j.bypassed
    }
  ];

  for (const upstream of upstreams) {
    try {
      log(`Probing upstream resolver [${upstream.name}]...`);
      const uRes = await timedFetch(upstream.url);
      if (uRes.ok) {
        const data = await uRes.json();
        const extracted = upstream.parse(data);
        if (extracted) {
          log(`Upstream [${upstream.name}] resolved payload.`);
          // If upstream returned an intermediate LootLabs link instead of the final key, chain it through our native LootLabs decrypter
          if (isLootLabsUrl(extracted)) {
            log(`Upstream returned intermediate LootLabs link (${extracted}). Chaining into local XOR + WebSocket solver...`);
            const unlocked = await bypassLootLabsNative(extracted, log);
            return { type: 'url', result: unlocked, intermediate: extracted };
          }
          return { type: 'key', result: extracted, source: upstream.name };
        }
      }
    } catch (e) {
      log(`Upstream [${upstream.name}] unreachable: ${e.message}`);
    }
  }

  throw new Error(
    'Platorelay ticket requires interactive session cookies or Turnstile token. Open the link once in your browser until it redirects to LootLabs (loot-link.com/s?...), then paste that LootLabs URL or r: cipher here for instant local XOR decryption.'
  );
}

async function followCheckpointAndRedeem(checkpointUrl, originPlatoUrl, serviceId, ticketId, log) {
  let callbackUrl = checkpointUrl;
  if (isLootLabsUrl(checkpointUrl)) {
    callbackUrl = await bypassLootLabsNative(checkpointUrl, log);
  }
  log(`Resolved checkpoint callback: ${callbackUrl}`);

  const cbParsed = new URL(callbackUrl);
  const tk = cbParsed.searchParams.get('tk') || cbParsed.searchParams.get('token');
  if (tk && serviceId && ticketId) {
    const putUrl = `https://api-gateway.platoboost.com/v1/sessions/auth/${serviceId}/${ticketId}/${tk}`;
    log(`Submitting token to Platoboost PUT endpoint: ${putUrl}`);
    const putRes = await timedFetch(putUrl, { method: 'PUT' });
    if (putRes.ok) {
      const checkRes = await timedFetch(`https://api-gateway.platoboost.com/v1/authenticators/${serviceId}/${ticketId}`);
      const checkJson = await checkRes.json();
      if (checkJson.key) {
        return { type: 'key', result: checkJson.key, callback: callbackUrl };
      }
    }
  }

  return { type: 'url', result: callbackUrl };
}

function isLootLabsUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return LOOTLABS_HOSTS.has(u.hostname.replace(/^www\./, ''));
  } catch {
    return false;
  }
}

function isPlatorelayUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return PLATOBOOST_HOSTS.has(u.hostname.replace(/^www\./, ''));
  } catch {
    return false;
  }
}

app.post('/api/bypass', async (req, res) => {
  const { input } = req.body || {};
  const logs = [];
  const log = (msg) => logs.push(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);

  if (!input || typeof input !== 'string' || input.length > 4096) {
    return res.status(400).json({ ok: false, error: 'Invalid input string', logs });
  }

  const trimmed = input.trim();

  try {
    // Case 1: Raw LootLabs r:<base64> or base64 XOR payload pasted directly
    if (trimmed.startsWith('r:') || (!trimmed.startsWith('http') && /^[A-Za-z0-9+/=]{16,}$/.test(trimmed))) {
      log(`Detected raw LootLabs base64 XOR ciphertext. Running 5-byte XOR keystream decrypt...`);
      const decoded = decodeLootLabsXor(trimmed, 5);
      log(`Decryption complete.`);
      return res.json({ ok: true, mode: 'xor-direct', result: decoded, logs });
    }

    // Case 2: LootLabs URL
    if (isLootLabsUrl(trimmed)) {
      log(`Detected LootLabs gateway URL.`);
      const decodedUrl = await bypassLootLabsNative(trimmed, log);
      return res.json({ ok: true, mode: 'lootlabs-native', result: decodedUrl, logs });
    }

    // Case 3: Platorelay / Platoboost URL
    if (isPlatorelayUrl(trimmed)) {
      log(`Detected Platorelay / Platoboost gateway URL.`);
      const outcome = await bypassPlatorelay(trimmed, log);
      return res.json({ ok: true, mode: 'platorelay-chain', ...outcome, logs });
    }

    // Case 4: Generic ad-link -> attempt query param extraction (&data=, &url=, &dest=) then upstream
    log(`Inspecting generic ad-link parameters...`);
    const fast = tryDecodeLootDataParam(trimmed);
    if (fast) {
      log(`Decoded &data= parameter with LootLabs 5-byte XOR.`);
      return res.json({ ok: true, mode: 'param-xor', result: fast, logs });
    }

    return res.status(422).json({
      ok: false,
      error: 'Unsupported domain or unrecognized payload format.',
      logs
    });
  } catch (err) {
    log(`ERROR: ${err.message}`);
    return res.status(500).json({ ok: false, error: err.message, logs });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[bench] Platorelay + LootLabs Bypasser listening on http://localhost:${PORT}`);
});
