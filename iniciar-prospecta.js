#!/usr/bin/env node
// Ponte local do Prospecta: entrega o painel e liga ele ao motor (gosom/google-maps-scraper).
// Sem dependências: só Node 18+. Escuta apenas em 127.0.0.1.
//   /                 -> Prospecta.html
//   /api/*            -> motor em ENGINE_URL (padrão http://127.0.0.1:8080)
//   /geocodificar     -> cidade -> latitude, longitude e caixa (OpenStreetMap Nominatim)
//   /enriquecer       -> lê o site da empresa: redes sociais, WhatsApp e e-mail
//   /ponte/status     -> diz se a ponte e o motor estão no ar
const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { exec, execFile } = require('child_process');

const PORT = Number(process.env.PROSPECTA_PORT) || 8765;
const ENGINE = new URL(process.env.ENGINE_URL || 'http://127.0.0.1:8080');
const PAGE = path.join(__dirname, 'Prospecta.html');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

// Só aceita pedidos feitos pelo painel: o Host precisa ser local e o cabeçalho X-Prospecta presente.
// Isso impede que outro site aberto no navegador use a ponte (DNS rebinding e pedidos entre sites).
const hostOk = (h) => /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(h || '');
const fromPanel = (req) => req.headers['x-prospecta'] === '1';

// ponytail: bloqueia IPs privados só por faixa; um proxy corporativo que reescreva DNS pode furar.
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
}

async function safeUrl(raw) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch { throw new Error('endereço inválido'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('só http e https');
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) { if (privateIp(u.hostname.replace(/^\[|\]$/g, ''))) throw new Error('endereço local bloqueado'); }
  else {
    const addrs = await dns.lookup(u.hostname, { all: true });
    if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new Error('endereço local bloqueado');
  }
  return u;
}

async function getHtml(raw, timeout = 8000, max = 1_500_000) {
  let u = await safeUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(u, { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'pt-BR,pt;q=0.9' } });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = await safeUrl(new URL(r.headers.get('location'), u).href); continue; }
      if (!r.ok) throw new Error('site respondeu ' + r.status);
      if (!/html|text/i.test(r.headers.get('content-type') || 'text/html')) throw new Error('não é uma página');
      let size = 0; const chunks = [];
      for await (const c of r.body) { size += c.length; chunks.push(c); if (size > max) break; }
      return { html: Buffer.concat(chunks).toString('utf8'), url: u };
    } finally { clearTimeout(t); }
  }
  throw new Error('redirecionamentos demais');
}

const SOCIAL = {
  instagram: /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]+)/gi,
  facebook: /https?:\/\/(?:www\.|m\.|web\.|pt-br\.)?facebook\.com\/([A-Za-z0-9_.\-]+)/gi,
  linkedin: /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|in|school)\/([A-Za-z0-9_.\-%]+)/gi,
};
const SKIP = new Set(['', 'p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'tv', 'direct', 'share', 'sharer', 'sharer.php', 'dialog', 'plugins', 'tr', 'home', 'pages', 'people', 'help', 'about', 'policies', 'policy', 'login', 'groups', 'watch', 'events', 'hashtag', 'profile.php', 'privacy', 'legal', 'business']);
const WA = /(?:wa\.me\/|api\.whatsapp\.com\/send\/?\?(?:[^"'\s]*&)?phone=|whatsapp\.com\/send\/?\?(?:[^"'\s]*&)?phone=)\+?(\d{10,15})/i;
const MAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const JUNK = /\.(png|jpe?g|gif|webp|svg|css|js|woff2?)$|sentry|wixpress|example\.|domain\.com|seuemail|email@|nome@|@2x/i;

// Telefones que aparecem logo depois de "WhatsApp/wpp/zap" (até 30 caracteres antes, sem outro telefone no meio):
// é a evidência de que aquele número atende no WhatsApp. Devolve 55DDDNÚMERO.
const PHONE = /\(?\b(\d{2})\)?[\s.-]?(9?\d{4})[\s.-]?(\d{4})\b/g;
function waNear(text) {
  const t = String(text || ''), out = new Set(); let prevEnd = 0;
  for (const m of t.matchAll(PHONE)) {
    if (/whats|wpp|zap/i.test(t.slice(Math.max(prevEnd, m.index - 30), m.index))) out.add('55' + m[1] + m[2] + m[3]);
    prevEnd = m.index + m[0].length;
  }
  return [...out];
}
function waLinks(html) {
  const re = new RegExp(WA.source, 'gi'), out = new Set(); let m;
  while ((m = re.exec(html))) out.add(m[1].startsWith('55') ? m[1] : '55' + m[1]);
  return [...out];
}
function findSocials(html) {
  const out = {};
  for (const [k, re] of Object.entries(SOCIAL)) {
    re.lastIndex = 0; let m;
    while ((m = re.exec(html))) {
      const h = m[1].replace(/[.\-]+$/, '');
      if (!SKIP.has(h.toLowerCase()) && !(k === 'facebook' && (/^\d+$/.test(h) || h.length < 3))) { out[k] = m[0].replace(/[.\-]+$/, ''); break; }
    }
  }
  const text = plain(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' '));
  const all = [...new Set([...waLinks(html), ...waNear(text)])];
  if (all.length) { out.whatsapp = all[0]; out.whatsapps = all; }
  return out;
}
function findEmails(html, site) {
  const found = new Set();
  for (const m of html.matchAll(/mailto:([^"'>\s?]+)/gi)) found.add(decodeURIComponent(m[1]).toLowerCase());
  for (const m of html.matchAll(MAIL)) found.add(m[0].toLowerCase());
  const dom = site.hostname.replace(/^www\./, '');
  return [...found].filter((e) => !JUNK.test(e)).sort((a, b) => Number(b.endsWith(dom)) - Number(a.endsWith(dom))).slice(0, 3);
}
function contactLinks(html, base) {
  const out = [];
  for (const m of html.matchAll(/<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (!/contato|contact|sobre|about|fale|atendimento/i.test(m[1] + ' ' + m[2].replace(/<[^>]+>/g, ''))) continue;
    try { const u = new URL(m[1], base); if (u.hostname === base.hostname && /^https?:$/.test(u.protocol) && !out.includes(u.href)) out.push(u.href); } catch { /* link quebrado */ }
    if (out.length >= 3) break;
  }
  for (const p of ['/contato', '/contact', '/sobre']) { const h = new URL(p, base).href; if (out.length < 3 && !out.includes(h)) out.push(h); }
  return out;
}

async function enrich(raw) {
  const home = await getHtml(raw);
  let all = home.html;
  let r = { ...findSocials(all), emails: findEmails(all, home.url) };
  if (!r.emails.length || !r.instagram) {
    for (const link of contactLinks(home.html, home.url)) {
      try { all += (await getHtml(link, 6000, 600_000)).html; } catch { /* página opcional */ }
    }
    r = { ...findSocials(all), emails: findEmails(all, home.url) };
  }
  return r;
}

// ---- Descoberta por busca na web ----
// O Google Maps costuma deixar o campo "site" vazio mesmo quando a empresa tem site e Instagram. Aqui pesquisamos o nome
// (DuckDuckGo, sem chave) e só aceitamos um resultado se o nome bate; no site ainda conferimos o telefone.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const GENERIC = new Set('de da do dos das e em a o sp rio preto sao jose academia academias clinica clinicas centro studio estudio fit fitness treinamento personalizado premium boa vista ltda me epp unidade filial com'.split(' '));
function tokens(nome, cidade) {
  const city = new Set(norm(cidade).split(/[^a-z0-9]+/));
  const all = [...new Set(norm(nome).split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !city.has(t)))];
  const key = all.filter((t) => !GENERIC.has(t));
  return key.length ? key : all;
}
const share = (text, toks) => (toks.length ? toks.filter((t) => norm(text).includes(t)).length / toks.length : 0);
const plain = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const BLOCK = ['google.', 'goo.gl', 'waze.', 'tripadvisor', 'foursquare', 'yelp.', 'apontador', 'guiamais', 'telelistas', 'todosnegocios', 'benditoguia', 'localtreino', 'ajptour', 'top-rated', 'cylex', 'yellowpages', 'solutudo', 'econodata', 'casadosdados', 'cnpj', 'serasa', 'reclameaqui', 'mercadolivre', 'olx.', 'youtube.', 'youtu.be', 'tiktok.', 'twitter.', 'x.com', 'pinterest.', 'wikipedia.', 'linktr.ee', 'beacons.ai', 'ifood.', 'rappi.', 'doctoralia.', 'booksy.', 'trinks.', 'gympass.', 'wellhub.', 'totalpass.', 'classpass.', 'reddit.', 'jusbrasil.', 'bing.', 'duckduckgo.', 'infoisinfo', 'hagah.', 'guiafacil', 'whatsapp.', 'wa.me', 'instagram.', 'facebook.', 'fb.com', 'linkedin.', 'mapcarta', 'listamais', 'tupalo', 'paginasamarelas', 'amazon.', 'shopee', 'academiapedia', 'melhoresacademias', 'qual-academia', 'consultaempresa', 'empresasbr', 'cnpj.biz', 'opencnpj', 'sebrae.', 'gov.br'];

// Buscadores sem chave de API, em cadeia: Brave primeiro, DuckDuckGo de reserva. Ambos limitam rajadas (o DuckDuckGo chegou a
// bloquear o IP por horas depois de ~3 consultas em 5 s), então espaçamos as consultas e, se um bloquear, pausamos só ele.
// Serper (Google de verdade, com chave): a chave fica em chave-serper.txt (criado por configurar-busca.bat) ou na variável SERPER_API_KEY.
const KEYFILE = path.join(__dirname, 'chave-serper.txt');
const serperKey = () => process.env.SERPER_API_KEY || (fs.existsSync(KEYFILE) ? fs.readFileSync(KEYFILE, 'utf8').trim() : '');
const motores = [
  { nome: 'serper', gap: 600, pausa: 10 * 60_000, last: 0, ate: 0, fn: async (q) => {
    const k = serperKey(); if (!k) return [];
    const r = await fetch('https://google.serper.dev/search', { method: 'POST', headers: { 'X-API-KEY': k, 'Content-Type': 'application/json' }, body: JSON.stringify({ q, gl: 'br', hl: 'pt-br', num: 10 }), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('serper ' + r.status);
    return ((await r.json()).organic || []).map((o) => ({ url: o.link, title: o.title || '', snippet: o.snippet || '' }));
  } },
  { nome: 'brave', gap: 12000, pausa: 60_000, last: 0, ate: 0, fn: async (q) => {
    // O fetch do Node leva 429 do Brave (pela assinatura da conexão); o curl do sistema passa (testado em 2026-10-23).
    const raw = await new Promise((ok, no) => execFile('curl', ['-s', '-m', '20', '-L', '-A', UA, '-H', 'Accept-Language: pt-BR,pt;q=0.9', '-w', '\n%{http_code}', 'https://search.brave.com/search?source=web&q=' + encodeURIComponent(q)], { maxBuffer: 8e6 }, (e, out) => (e ? no(e) : ok(out))));
    const status = Number(raw.slice(raw.lastIndexOf('\n') + 1)); if (status === 429 || status === 403) throw new Error('limite do Brave');
    const html = raw.slice(0, raw.lastIndexOf('\n')); const out = [];
    for (const blk of html.split('class="snippet ').slice(1)) {
      const a = /<a[^>]*href="(https?:[^"]+)"/.exec(blk); if (!a) continue;
      const t = /class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(blk), d = /class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(blk);
      out.push({ url: a[1].replace(/&amp;/g, '&'), title: plain(t ? t[1] : ''), snippet: plain(d ? d[1] : '') });
    }
    return out.slice(0, 10);
  } },
  { nome: 'duckduckgo', gap: 8000, pausa: 10 * 60_000, last: 0, ate: 0, fn: async (q) => {
    const r = await fetch('https://html.duckduckgo.com/html/?kl=br-pt&q=' + encodeURIComponent(q), { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' }, signal: AbortSignal.timeout(12000) });
    const html = await r.text(); const links = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
    if (!links.length) { if (/captcha|anomaly/i.test(html) || r.status === 202) throw new Error('limite do DuckDuckGo'); return []; }
    const snips = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
    return links.slice(0, 10).map((m, i) => {
      let u = m[1].replace(/&amp;/g, '&'); const g = /uddg=([^&]+)/.exec(u); u = g ? decodeURIComponent(g[1]) : (u.startsWith('//') ? 'https:' + u : u);
      return { url: u, title: plain(m[2]), snippet: plain((snips[i] || [])[1] || '') };
    });
  } },
];
async function ddg(q, soSerper) {
  // soSerper: com chave, usa só o Google (resultado vazio é resposta válida; não cai nos buscadores gratuitos bloqueados)
  if (soSerper && serperKey()) { const m = motores[0]; await sleep(Math.max(0, m.gap - (Date.now() - m.last))); m.last = Date.now(); return m.fn(q); }
  for (let ciclo = 0; ciclo < 3; ciclo++) {
    for (const m of motores) {
      if (Date.now() < m.ate) continue;
      await sleep(Math.max(0, m.gap - (Date.now() - m.last))); m.last = Date.now();
      try { const r = await m.fn(q); if (r.length) return r; } catch { m.ate = Date.now() + m.pausa; }
    }
    // todos em pausa: espera o primeiro voltar (até 2 min) e tenta de novo
    const esp = Math.min(...motores.map((m) => m.ate)) - Date.now();
    if (esp > 120_000) break; if (esp > 0) await sleep(esp + 500);
  }
  throw new Error('buscadores indisponíveis agora (limite); tente em alguns minutos');
}
const allTokens = (nome, cidade) => { const city = new Set(norm(cidade).split(/[^a-z0-9]+/)); return [...new Set(norm(nome).split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !city.has(t)))]; };
function socials(results, toks, all) {
  const OFF = { instagram: ['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'tv', 'directory', 'popular'], facebook: ['sharer', 'share', 'watch', 'groups', 'events', 'photo', 'login', 'posts', 'public', 'people', 'hashtag', 'reel', 'marketplace', 'story.php'] };
  const best = {};
  results.forEach((r, pos) => {
    let u; try { u = new URL(r.url); } catch { return; }
    const host = u.hostname.replace(/^www\.|^m\.|^pt-br\.|^web\./, ''), seg = u.pathname.split('/').filter(Boolean);
    if (!seg[0]) return;
    const text = `${r.title} ${r.snippet} ${seg.join(' ')}`, sc = share(text, toks);
    if (sc < 0.34) return;
    const rank = sc * 10 + share(text, all) * 5 - pos * 0.01; // empate (mesma rede, várias unidades): vence quem casa mais palavras do nome, inclusive o bairro
    const conf = sc >= 0.66 && share(text, all) >= 0.5 ? 'alta' : 'media';
    let net = null, url = null;
    if (host === 'instagram.com' && !OFF.instagram.includes(seg[0])) { net = 'instagram'; url = 'https://www.instagram.com/' + seg[0]; }
    else if (host === 'facebook.com' && !OFF.facebook.includes(seg[0])) { net = 'facebook'; url = 'https://www.facebook.com/' + (seg[0] === 'pages' ? seg.slice(0, 3) : seg[0] === 'p' ? seg.slice(0, 2) : seg.slice(0, 1)).join('/'); }
    else if (host === 'linkedin.com' && seg[0] === 'company' && seg[1]) { net = 'linkedin'; url = 'https://www.linkedin.com/company/' + seg[1]; }
    if (net && (!best[net] || rank > best[net].rank)) best[net] = { url, conf, titulo: r.title, rank };
  });
  for (const k of Object.keys(best)) delete best[k].rank;
  return best;
}
async function siteDe(results, toks, fone) {
  const last8 = String(fone || '').replace(/\D/g, '').slice(-8);
  for (const r of results.slice(0, 6)) {
    let u; try { u = new URL(r.url); } catch { continue; }
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (BLOCK.some((b) => host.includes(b))) continue;
    const sc = share(`${r.title} ${r.snippet} ${host}`, toks);
    // Site oficial tem o nome da empresa no endereço (skyfit.com.br); diretórios (fitclick, guias) não.
    const hostPlain = host.replace(/[^a-z0-9]/g, '');
    if (sc < 0.34 || !toks.some((t) => hostPlain.includes(t))) continue;
    let telOk = false;
    try { telOk = last8.length === 8 && (await getHtml(r.url, 7000, 800_000)).html.replace(/\D/g, '').includes(last8); } catch { /* site fora do ar: segue só pelo nome */ }
    if (telOk || sc >= 0.66) return { url: r.url.replace(/[?#].*$/, ''), conf: telOk ? 'alta' : 'media', motivo: telOk ? 'telefone confere' : 'nome confere', titulo: r.title };
  }
  return null;
}
// WhatsApp divulgado pela empresa: só vale resultado que tem o nome dela (ou o próprio telefone) e o número logo após "WhatsApp".
// Com telefone do Maps, só conta o número que bate com ele (confirma "este celular é WhatsApp") e devolve o número do Maps
// em formato certo; outras unidades da rede e números digitados errados nas páginas ficam de fora.
function waDe(results, toks, fone) {
  let d = String(fone || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  const canon = d.length === 10 || d.length === 11 ? '55' + d : '', last8 = d.slice(-8), out = new Set();
  for (const r of results) {
    const text = `${r.title} ${r.snippet}`;
    if (share(`${text} ${r.url}`, toks) >= 0.34 || (last8.length === 8 && text.replace(/\D/g, '').includes(last8))) {
      for (const n of waNear(text)) { if (!canon) out.add(n); else if (n.slice(-8) === last8) out.add(canon); }
    }
  }
  return [...out];
}
async function descobrir(nome, cidade, fone) {
  const toks = tokens(nome, cidade), all = allTokens(nome, cidade);
  const res = await ddg(`${nome} ${cidade}`);
  let out = socials(res, toks, all); const site = await siteDe(res, toks, fone); const whatsapps = waDe(res, toks, fone);
  if (!out.instagram) { await sleep(1200); try { out = { ...socials(await ddg(`${nome} instagram ${cidade}`), toks, all), ...out }; } catch { /* segunda consulta é opcional */ } }
  return { ...out, site, whatsapps, verificado: true };
}
// Conferência só do WhatsApp: pesquisa o nome + "whatsapp" e o próprio número + "whatsapp".
async function conferirWa(nome, cidade, fone) {
  const toks = tokens(nome, cidade), out = new Set();
  const qs = [`${nome} ${cidade} whatsapp`];
  const d = String(fone || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  if (d.length === 10 || d.length === 11) qs.push(`"${d.slice(0, 2)} ${d.slice(2, d.length - 4)}-${d.slice(-4)}" whatsapp`);
  for (const q of qs) waDe(await ddg(q, true), toks, fone).forEach((n) => out.add(n));
  return { whatsapps: [...out], verificado: true };
}

function proxy(req, res) {
  const opts = { hostname: ENGINE.hostname, port: ENGINE.port || 80, path: req.url, method: req.method, headers: { ...req.headers, host: ENGINE.host } };
  delete opts.headers.origin; delete opts.headers.referer; delete opts.headers['x-prospecta'];
  const up = http.request(opts, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => json(res, 502, { message: 'motor desligado' }));
  req.pipe(up);
}

function engineUp() {
  return new Promise((ok) => {
    const q = http.get({ hostname: ENGINE.hostname, port: ENGINE.port || 80, path: '/api/v1/jobs', timeout: 2500 }, (r) => { r.resume(); ok(r.statusCode < 500); });
    q.on('error', () => ok(false)); q.on('timeout', () => { q.destroy(); ok(false); });
  });
}

async function geocode(q) {
  const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=pt-BR&q=' + encodeURIComponent(q), { headers: { 'User-Agent': 'Prospecta/3 (uso pessoal)' } });
  const j = await r.json();
  if (!j[0]) return null;
  const [s, n, w, e] = j[0].boundingbox.map(Number);
  return { lat: Number(j[0].lat), lon: Number(j[0].lon), bbox: [s, n, w, e], nome: j[0].display_name };
}

const server = http.createServer(async (req, res) => {
  if (!hostOk(req.headers.host)) { res.writeHead(403); return res.end('host não permitido'); }
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/' || url.pathname === '/Prospecta.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      // O arquivo é escrito para o Artifact (sem doctype nem charset); aqui completamos o cabeçalho.
      return res.end('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + fs.readFileSync(PAGE, 'utf8'));
    }
    if (!fromPanel(req)) { res.writeHead(403); return res.end('abra o painel pelo endereço da ponte'); }
    if (url.pathname.startsWith('/api/')) return proxy(req, res);
    if (url.pathname === '/ponte/status') return json(res, 200, { ponte: true, motor: await engineUp(), busca: serperKey() ? 'google' : 'gratuita' });
    if (url.pathname === '/descobrir') {
      try { return json(res, 200, await descobrir(url.searchParams.get('nome') || '', url.searchParams.get('cidade') || '', url.searchParams.get('fone') || '')); }
      catch (e) { return json(res, 200, { erro: e.message || 'falha na busca' }); }
    }
    if (url.pathname === '/whatsapp') {
      try { return json(res, 200, await conferirWa(url.searchParams.get('nome') || '', url.searchParams.get('cidade') || '', url.searchParams.get('fone') || '')); }
      catch (e) { return json(res, 200, { erro: e.message || 'falha na busca' }); }
    }
    if (url.pathname === '/geocodificar') {
      const g = await geocode(url.searchParams.get('q') || '');
      return g ? json(res, 200, g) : json(res, 404, { message: 'região não encontrada' });
    }
    if (url.pathname === '/enriquecer') {
      try { return json(res, 200, await enrich(url.searchParams.get('url') || '')); }
      catch (e) { return json(res, 200, { erro: e.message || 'falha ao ler o site' }); }
    }
    res.writeHead(404); res.end('não encontrado');
  } catch (e) { json(res, 500, { message: String(e.message || e) }); }
});

server.listen(PORT, '127.0.0.1', async () => {
  const addr = `http://127.0.0.1:${PORT}`;
  console.log(`Prospecta no ar em ${addr}`);
  console.log((await engineUp()) ? `Motor encontrado em ${ENGINE.origin}.` : `Motor NÃO encontrado em ${ENGINE.origin}. Rode "docker compose up -d" nesta pasta e aguarde ~10 s.`);
  console.log('Feche esta janela para desligar.');
  if (!process.env.PROSPECTA_NO_OPEN) exec(process.platform === 'win32' ? `start "" ${addr}` : process.platform === 'darwin' ? `open ${addr}` : `xdg-open ${addr}`);
});
