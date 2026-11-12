// VEIL — proxy web num único Cloudflare Worker.
// Serve: página inicial (/), script cliente (/inject.js) e o proxy (/p/<https|http>/<host>/<caminho>).
// Nota: Workers não conseguem aceder a .onion nem a redes privadas.

const PROXY_PATH = /^\/p\/(https?)\/([^/]+)(\/.*)?$/;
const STRIP_RESPONSE = [
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'strict-transport-security', 'content-length',
  'report-to', 'nel', 'cross-origin-opener-policy', 'cross-origin-embedder-policy'
];

// ---------- segurança: nunca aceder a redes internas / ao próprio Worker ----------
function isBlocked(hostname, selfHost) {
  const h = String(hostname).toLowerCase();
  if (h === String(selfHost).toLowerCase()) return true;
  if (h.includes(':') || h.startsWith('[')) return true;                 // IPv6 literal
  if (!h.includes('.')) return true;                                      // nomes de intranet
  if (/\.(local|localhost|internal|onion|lan|home|corp)$/.test(h)) return true;
  const ip = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ip) {
    const a = +ip[1], b = +ip[2];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

// ---------- cookies isolados por site (evita vazar cookies entre sites) ----------
function siteKey(host) {
  const p = host.replace(/:\d+$/, '').toLowerCase().split('.');
  if (p.length <= 2) return p.join('.');
  const sld = p[p.length - 2], tld = p[p.length - 1];
  const n = (tld.length === 2 && /^(co|com|org|net|gov|edu|ac|or|ne|go)$/.test(sld)) ? 3 : 2;
  return p.slice(-n).join('.');
}
const cookiePrefix = host => 'v!' + siteKey(host) + '!';

function upstreamCookies(header, pre) {
  if (!header) return null;
  const out = header.split(/;\s*/).filter(c => c.startsWith(pre)).map(c => c.slice(pre.length));
  return out.length ? out.join('; ') : null;
}
function fixCookie(c, pre) {
  c = c.replace(/;\s*Domain=[^;]*/ig, '').replace(/;\s*Path=[^;]*/ig, '')
       .replace(/;\s*SameSite=[^;]*/ig, '').replace(/;\s*Partitioned/ig, '');
  return pre + c + '; Path=/; SameSite=Lax';
}
function readSite(cookieHeader) {
  const mm = (cookieHeader || '').match(/(?:^|;\s*)veil_site=([^;]+)/);
  if (!mm) return null;
  try { const o = decodeURIComponent(mm[1]); return /^https?:\/\//.test(o) ? new URL(o).origin : null; }
  catch { return null; }
}

// ---------- reescrita de URLs ----------
function makeProx(selfHost) {
  return function prox(v, base) {
    try {
      if (v == null) return v;
      v = String(v).trim();
      if (!v || v.startsWith('#')) return v;
      const a = new URL(v, base);
      if (!/^https?:$/.test(a.protocol)) return v;
      if (isBlocked(a.hostname, selfHost)) return a.href;
      return '/p/' + a.protocol.slice(0, -1) + '/' + a.host + a.pathname + a.search + a.hash;
    } catch { return v; }
  };
}
// Links <a>: mantém o caminho real quando é o mesmo site (routers de SPA precisam disso)
function navHref(v, base, prox) {
  try {
    v = String(v).trim();
    if (!v || v.startsWith('#')) return v;
    const a = new URL(v, base), b = new URL(base);
    if (/^https?:$/.test(a.protocol) && a.host === b.host && a.pathname !== '/') return a.pathname + a.search + a.hash;
  } catch {}
  return prox(v, base);
}

class Rewrite {
  constructor(base, prox) { this.base = base; this.prox = prox; }
  element(el) {
    const isNav = el.tagName === 'a' || el.tagName === 'area';
    for (const a of ['href', 'src', 'action', 'poster', 'data-src']) {
      const v = el.getAttribute(a);
      if (v === null) continue;
      el.setAttribute(a, (isNav && a === 'href') ? navHref(v, this.base, this.prox) : this.prox(v, this.base));
    }
    const ss = el.getAttribute('srcset');
    if (ss) {
      el.setAttribute('srcset', ss.split(',').map(p => {
        const [u, ...d] = p.trim().split(/\s+/);
        return [this.prox(u, this.base), ...d].join(' ');
      }).join(', '));
    }
    el.removeAttribute('integrity');
  }
}

// Redirecionamentos feitos por JavaScript inline (ex.: links de resultados do Bing)
function rewriteNav(s) {
  if (!s.includes('location')) return s;
  return s
    .replace(/(?<![\w$.])(?:(?:window|document|self)\.)?location\.(replace|assign)\s*\(/g, '__veil.$1(')
    .replace(/(?<![\w$.])(?:(?:window|document|self)\.)?location\.href\s*=(?!=)/g, '__veil.href=')
    .replace(/(?<![\w$.])(?:window|document|self)\.location\s*=(?!=)/g, '__veil.href=');
}
class ScriptRewrite {
  constructor() { this.buf = ''; }
  text(t) {
    if (!t.lastInTextNode) { this.buf += t.text; t.remove(); return; }
    const s = this.buf + t.text;
    this.buf = '';
    if (s) t.replace(rewriteNav(s), { html: true });
  }
}

function fallback(request, reqUrl) {
  const site = readSite(request.headers.get('cookie'));
  if (!site) return new Response('Não encontrado', { status: 404 });
  const u = new URL(site);
  const loc = '/p/' + u.protocol.slice(0, -1) + '/' + u.host + reqUrl.pathname + reqUrl.search;
  return new Response(null, { status: ['GET', 'HEAD'].includes(request.method) ? 302 : 307, headers: { location: loc } });
}

async function proxy(request, reqUrl, m) {
  const selfHost = reqUrl.hostname;
  const host = m[2];
  let target;
  try { target = new URL(m[1] + '://' + host + (m[3] || '/') + reqUrl.search); }
  catch { return new Response('URL inválido', { status: 400 }); }
  if (isBlocked(target.hostname, selfHost)) return new Response('Destino bloqueado', { status: 403 });

  const prox = makeProx(selfHost);
  const pre = cookiePrefix(target.host);
  const cookieHeader = request.headers.get('cookie');
  const isDoc = request.headers.get('sec-fetch-dest') === 'document';
  const isRead = ['GET', 'HEAD'].includes(request.method);
  const pageOrigin = isDoc ? null : readSite(cookieHeader);

  // cabeçalhos para o site de destino
  const h = new Headers(request.headers);
  for (const k of [...h.keys()]) {
    if (k.startsWith('cf-') || k.startsWith('sec-fetch-') || k.startsWith('x-forwarded-')) h.delete(k);
  }
  ['host', 'x-real-ip', 'cdn-loop'].forEach(k => h.delete(k));
  const ck = upstreamCookies(cookieHeader, pre);
  if (ck) h.set('cookie', ck); else h.delete('cookie');
  if (pageOrigin && pageOrigin !== target.origin) {
    h.set('origin', pageOrigin);                  // imita o pedido vindo da página original
    h.set('referer', pageOrigin + '/');
  } else {
    h.set('referer', target.origin + '/');
    if (!isRead) h.set('origin', target.origin); else h.delete('origin');
  }

  let res;
  try {
    res = await fetch(target.href, { method: request.method, headers: h, body: isRead ? undefined : request.body, redirect: 'manual' });
  } catch (e) {
    return new Response('Erro ao contactar ' + target.host + ': ' + e.message, { status: 502 });
  }

  const out = new Headers(res.headers);
  STRIP_RESPONSE.forEach(k => out.delete(k));
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  out.delete('set-cookie');
  cookies.forEach(c => out.append('set-cookie', fixCookie(c, pre)));
  const loc = out.get('location');
  if (loc) out.set('location', navHref(loc, target.href, prox));

  const type = out.get('content-type') || '';

  if (type.includes('text/html')) {
    out.delete('content-encoding');
    if (isDoc) out.append('set-cookie', 'veil_site=' + encodeURIComponent(target.origin) + '; Path=/; Secure; SameSite=Lax; Max-Age=86400');
    return new HTMLRewriter()
      .on('meta[http-equiv]', { element(e) {
        const he = e.getAttribute('http-equiv') || '';
        if (/content-security-policy/i.test(he)) { e.remove(); return; }
        if (/refresh/i.test(he)) {
          const mm = (e.getAttribute('content') || '').match(/^\s*(\d*\.?\d*)\s*[;,]\s*url\s*=\s*['"]?([^'"]+)['"]?\s*$/i);
          if (mm) e.setAttribute('content', (mm[1] || '0') + ';url=' + navHref(mm[2], target.href, prox));
        }
      } })
      .on('base', { element(e) { e.remove(); } })
      .on('script', new ScriptRewrite())
      .on('*', new Rewrite(target.href, prox))
      .on('head', { element(e) { e.prepend('<script src="/inject.js?v=4"></script>', { html: true }); } })
      .transform(new Response(res.body, { status: res.status, headers: out }));
  }

  if (type.includes('text/css')) {
    out.delete('content-encoding');
    let css = await res.text();
    css = css
      .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (_, q, u) => `url(${q}${prox(u, target.href)}${q})`)
      .replace(/@import\s+(['"])(.*?)\1/g, (_, q, u) => `@import ${q}${prox(u, target.href)}${q}`);
    return new Response(css, { status: res.status, headers: out });
  }

  return new Response(res.body, { status: res.status, headers: out });
}

const INDEX_HTML = String.raw`<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0b14">
<title>VEIL</title>
<style>
  :root{--bg:#0a0a14;--panel:rgba(22,22,46,.72);--line:rgba(255,255,255,.09);--text:#eef0ff;--muted:#9a9cc4;--a1:#4f8cff;--a2:#8b5cf6}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;min-height:100%}
  body{background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;overflow-x:hidden}
  .bg{position:fixed;inset:0;z-index:-1;overflow:hidden}
  .blob{position:absolute;width:55vmax;height:55vmax;border-radius:50%;filter:blur(90px);opacity:.38;animation:float 22s ease-in-out infinite alternate}
  .b1{background:var(--a1);top:-20vmax;left:-15vmax}
  .b2{background:var(--a2);bottom:-25vmax;right:-15vmax;animation-delay:-8s}
  .b3{background:var(--a2);top:30%;left:45%;width:30vmax;height:30vmax;opacity:.18;animation-delay:-14s}
  @keyframes float{to{transform:translate(6vmax,4vmax) scale(1.12)}}
  body[data-bg=grade] .blob{display:none}
  body[data-bg=grade] .bg{background:radial-gradient(circle at 50% 0%,color-mix(in srgb,var(--a2) 35%,transparent),transparent 60%),linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px) 0 0/44px 44px,linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px) 0 0/44px 44px}
  body[data-bg=liso] .blob{display:none}
  @media(prefers-reduced-motion:reduce){.blob{animation:none}}

  .top{width:100%;max-width:1000px;display:flex;justify-content:space-between;align-items:center;padding:calc(env(safe-area-inset-top,0px) + 16px) 20px 0}
  .brand{font-weight:800;letter-spacing:3px;font-size:18px;background:linear-gradient(90deg,var(--a1),var(--a2));-webkit-background-clip:text;background-clip:text;color:transparent}
  .icon-btn{width:46px;height:46px;border-radius:14px;border:1px solid var(--line);background:var(--panel);color:var(--text);font-size:20px;cursor:pointer;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);transition:transform .15s,border-color .15s}
  .icon-btn:hover{border-color:var(--a2);transform:rotate(30deg)}

  main{width:100%;max-width:720px;padding:0 20px;margin:auto 0;text-align:center;display:flex;flex-direction:column;align-items:center}
  #hello{min-height:78px;margin-bottom:6px}
  #time{font-size:clamp(44px,9vw,68px);font-weight:200;letter-spacing:2px;line-height:1}
  #greet{color:var(--muted);margin-top:6px}
  h1{margin:0 0 20px;font-size:clamp(46px,10vw,78px);letter-spacing:6px;line-height:1;background:linear-gradient(90deg,var(--a1),var(--a2));-webkit-background-clip:text;background-clip:text;color:transparent}
  .search{width:100%;display:flex;gap:8px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:8px;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 20px 60px rgba(0,0,0,.35);transition:border-color .2s,box-shadow .2s}
  .search:focus-within{border-color:var(--a2);box-shadow:0 20px 60px rgba(0,0,0,.35),0 0 0 4px color-mix(in srgb,var(--a2) 25%,transparent)}
  .chip{flex:none;font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:10px;padding:6px 10px;white-space:nowrap}
  #u{flex:1;min-width:0;background:transparent;border:0;outline:0;color:var(--text);font:inherit;font-size:17px;padding:10px 6px}
  #u::placeholder{color:var(--muted)}
  .go{flex:none;border:0;border-radius:12px;padding:12px 22px;font:inherit;font-weight:600;color:#fff;cursor:pointer;background:linear-gradient(90deg,var(--a1),var(--a2));transition:transform .15s,filter .15s}
  .go:hover{filter:brightness(1.1)}.go:active{transform:scale(.96)}
  #err{color:#ff8a9a;min-height:22px;margin-top:10px;font-size:14px}

  .tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:14px;width:100%;margin-top:26px}
  .tile{display:flex;flex-direction:column;align-items:center;gap:8px;padding:14px 6px;border-radius:18px;border:1px solid var(--line);background:var(--panel);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);color:var(--text);text-decoration:none;font-size:13px;cursor:pointer;transition:transform .18s,border-color .18s;overflow:hidden}
  .tile:hover{transform:translateY(-4px);border-color:var(--a2)}
  .tile i{font-style:normal;width:46px;height:46px;border-radius:14px;display:grid;place-items:center;font-weight:700;font-size:20px;color:#fff;background:linear-gradient(135deg,var(--a1),var(--a2))}
  .tile span{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .note{margin:34px 0 calc(env(safe-area-inset-bottom,0px) + 24px);font-size:12px;color:var(--muted);max-width:520px}

  /* definições */
  #ov{position:fixed;inset:0;background:rgba(0,0,0,.55);opacity:0;pointer-events:none;transition:opacity .25s;z-index:10}
  #ov.on{opacity:1;pointer-events:auto}
  aside{position:fixed;top:0;right:0;bottom:0;width:min(400px,100vw);background:#12122a;border-left:1px solid var(--line);transform:translateX(100%);transition:transform .28s cubic-bezier(.2,.8,.2,1);z-index:11;display:flex;flex-direction:column}
  aside.on{transform:none}
  aside header{display:flex;justify-content:space-between;align-items:center;padding:calc(env(safe-area-inset-top,0px) + 18px) 20px 14px;border-bottom:1px solid var(--line)}
  aside h2{margin:0;font-size:20px}
  .x{background:none;border:0;color:var(--muted);font-size:26px;cursor:pointer;padding:4px 10px}
  .body{flex:1;overflow:auto;padding:6px 20px 28px}
  .sec{padding:16px 0;border-bottom:1px solid var(--line)}
  .sec:last-child{border:0}
  .sec h3{margin:0 0 10px;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted)}
  .seg{display:flex;flex-wrap:wrap;gap:8px}
  .seg button{flex:1 1 auto;min-height:44px;border-radius:12px;border:1px solid var(--line);background:transparent;color:var(--text);font:inherit;cursor:pointer;padding:8px 12px}
  .seg button.on{border-color:var(--a2);background:color-mix(in srgb,var(--a2) 22%,transparent)}
  .sw{display:flex;gap:12px;flex-wrap:wrap}
  .sw button{width:44px;height:44px;border-radius:50%;border:3px solid transparent;cursor:pointer}
  .sw button.on{border-color:#fff}
  .row{display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:46px}
  .row small{color:var(--muted);display:block}
  .switch{position:relative;flex:none;width:52px;height:30px}
  .switch input{opacity:0;width:100%;height:100%;position:absolute;margin:0;cursor:pointer;z-index:1}
  .switch span{position:absolute;inset:0;border-radius:99px;background:#2a2a50;transition:background .2s}
  .switch span::after{content:"";position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:50%;background:#fff;transition:transform .2s}
  .switch input:checked+span{background:linear-gradient(90deg,var(--a1),var(--a2))}
  .switch input:checked+span::after{transform:translateX(22px)}
  .list{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
  .item{display:flex;justify-content:space-between;align-items:center;gap:8px;border:1px solid var(--line);border-radius:12px;padding:8px 8px 8px 14px;font-size:14px}
  .item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .item button{border:0;background:rgba(255,90,120,.15);color:#ff8a9a;border-radius:10px;width:38px;height:38px;cursor:pointer;font-size:16px}
  .add{display:grid;gap:8px}
  .add input{background:#0b0b1c;border:1px solid var(--line);border-radius:12px;color:var(--text);font:inherit;padding:12px;outline:0;min-width:0}
  .add input:focus{border-color:var(--a2)}
  .btn{border:1px solid var(--line);background:transparent;color:var(--text);font:inherit;border-radius:12px;min-height:44px;padding:8px 14px;cursor:pointer;text-decoration:none;display:flex;align-items:center;justify-content:center}
  .btn.p{border:0;background:linear-gradient(90deg,var(--a1),var(--a2));color:#fff;font-weight:600}
  .btn.d{color:#ff8a9a;border-color:rgba(255,90,120,.35)}
  .stack{display:grid;gap:8px}
  #toast{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 24px);transform:translate(-50%,30px);background:#1c1c3c;border:1px solid var(--line);padding:10px 18px;border-radius:12px;opacity:0;transition:.25s;z-index:20;font-size:14px;pointer-events:none}
  #toast.on{opacity:1;transform:translate(-50%,0)}
  @media(max-width:520px){.chip{display:none}.go{padding:12px 16px}}
</style>
</head>
<body data-bg="aurora">
<div class="bg"><div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div></div>

<div class="top">
  <span class="brand">VEIL</span>
  <button class="icon-btn" id="open" aria-label="Definições">⚙</button>
</div>

<main>
  <div id="hello"><div id="time"></div><div id="greet"></div></div>
  <h1>VEIL</h1>
  <form class="search" id="f">
    <span class="chip" id="chip"></span>
    <input id="u" placeholder="Pesquisar ou escrever um endereço" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go">
    <button class="go">Ir</button>
  </form>
  <div id="err"></div>
  <div class="tiles" id="tiles"></div>
  <div class="note">Sites muito pesados (vídeo, logins com captcha) podem não funcionar. Endereços .onion não são suportados aqui.</div>
</main>

<div id="ov"></div>
<aside id="panel" aria-hidden="true">
  <header><h2>Definições</h2><button class="x" id="close" aria-label="Fechar">×</button></header>
  <div class="body">
    <div class="sec"><h3>Motor de pesquisa</h3><div class="seg" id="engines"></div></div>
    <div class="sec"><h3>Cor de destaque</h3><div class="sw" id="accents"></div></div>
    <div class="sec"><h3>Fundo</h3><div class="seg" id="bgs"></div></div>
    <div class="sec">
      <div class="row"><div>Relógio e saudação</div><label class="switch"><input type="checkbox" id="clock"><span></span></label></div>
      <div class="row"><div>Abrir sites numa nova aba</div><label class="switch"><input type="checkbox" id="newtab"><span></span></label></div>
    </div>
    <div class="sec">
      <h3>Atalhos</h3>
      <div class="list" id="tlist"></div>
      <div class="add">
        <input id="tn" placeholder="Nome (ex.: Wikipedia)" maxlength="18">
        <input id="tu" placeholder="Endereço (ex.: wikipedia.org)" autocapitalize="off" spellcheck="false">
        <button class="btn p" id="tadd" type="button">Adicionar atalho</button>
      </div>
    </div>
    <div class="sec">
      <h3>Dados</h3>
      <div class="stack">
        <a class="btn d" href="/_clear">Terminar sessão em todos os sites</a>
        <button class="btn" id="reset" type="button">Repor definições</button>
      </div>
    </div>
  </div>
</aside>
<div id="toast"></div>

<script>
var $ = function (id) { return document.getElementById(id); };
var ENGINES = {
  ddg: { n: 'DuckDuckGo', u: 'https://duckduckgo.com/html/?q=' },
  bing: { n: 'Bing', u: 'https://www.bing.com/search?q=' },
  startpage: { n: 'Startpage', u: 'https://www.startpage.com/do/search?q=' },
  brave: { n: 'Brave', u: 'https://search.brave.com/search?q=' }
};
var ACCENTS = {
  violet: ['#4f8cff', '#8b5cf6'], emerald: ['#22d3a6', '#3b82f6'], rose: ['#ff6b9a', '#8b5cf6'],
  amber: ['#ffb347', '#ff5e62'], cyan: ['#22d3ee', '#4f8cff']
};
var BGS = { aurora: 'Aurora', grade: 'Grelha', liso: 'Liso' };
var DEF = {
  engine: 'ddg', accent: 'violet', bg: 'aurora', clock: true, newtab: false,
  tiles: [
    { n: 'Pesquisar', u: 'https://duckduckgo.com/html/' },
    { n: 'Wikipedia', u: 'https://en.wikipedia.org/' },
    { n: 'Roblox', u: 'https://www.roblox.com/home' },
    { n: 'Bing', u: 'https://www.bing.com/' }
  ]
};
var S;
function load() {
  try { var s = JSON.parse(localStorage.getItem('veil_settings') || '{}'); return Object.assign({}, DEF, s); }
  catch (e) { return Object.assign({}, DEF); }
}
function save() { try { localStorage.setItem('veil_settings', JSON.stringify(S)); } catch (e) {} }
function toast(t) { var el = $('toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(function () { el.classList.remove('on'); }, 2200); }

function toProxy(raw) {
  var u = new URL(raw);
  if (/\.onion$/i.test(u.hostname)) throw new Error('Endereços .onion precisam do Tor e não funcionam num Worker.');
  return '/p/' + u.protocol.slice(0, -1) + '/' + u.host + u.pathname + u.search + u.hash;
}
function normalize(v) {
  v = v.trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (!/\s/.test(v) && /^[\w-]+(\.[\w-]+)+(:\d+)?([\/?#].*)?$/.test(v)) return 'https://' + v;
  return ENGINES[S.engine].u + encodeURIComponent(v);
}
function go(raw) {
  try {
    var p = toProxy(raw);
    if (S.newtab) window.open(p, '_blank'); else location.href = p;
  } catch (e) { $('err').textContent = e.message && e.message.indexOf('onion') > -1 ? e.message : 'Endereço inválido.'; }
}

function apply() {
  var a = ACCENTS[S.accent] || ACCENTS.violet, r = document.documentElement.style;
  r.setProperty('--a1', a[0]); r.setProperty('--a2', a[1]);
  document.body.setAttribute('data-bg', S.bg);
  $('chip').textContent = ENGINES[S.engine].n;
  $('hello').style.display = S.clock ? '' : 'none';
  $('clock').checked = S.clock; $('newtab').checked = S.newtab;
  tick(); renderTiles(); renderPanel();
}
function tick() {
  var d = new Date(), h = d.getHours();
  $('time').textContent = ('0' + h).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  $('greet').textContent = h < 6 ? 'Boa madrugada' : h < 12 ? 'Bom dia' : h < 20 ? 'Boa tarde' : 'Boa noite';
}
setInterval(tick, 20000);

function renderTiles() {
  var box = $('tiles'); box.innerHTML = '';
  S.tiles.forEach(function (t) {
    var a = document.createElement('a'); a.className = 'tile'; a.href = '#';
    var i = document.createElement('i'); i.textContent = (t.n || '?').trim().charAt(0).toUpperCase();
    var s = document.createElement('span'); s.textContent = t.n;
    a.appendChild(i); a.appendChild(s);
    a.addEventListener('click', function (e) { e.preventDefault(); go(t.u); });
    box.appendChild(a);
  });
}
function seg(id, items, cur, fn) {
  var box = $(id); box.innerHTML = '';
  Object.keys(items).forEach(function (k) {
    var b = document.createElement('button'); b.type = 'button';
    b.textContent = typeof items[k] === 'string' ? items[k] : items[k].n;
    if (k === cur) b.className = 'on';
    b.addEventListener('click', function () { fn(k); });
    box.appendChild(b);
  });
}
function renderPanel() {
  seg('engines', ENGINES, S.engine, function (k) { S.engine = k; save(); apply(); });
  seg('bgs', BGS, S.bg, function (k) { S.bg = k; save(); apply(); });
  var sw = $('accents'); sw.innerHTML = '';
  Object.keys(ACCENTS).forEach(function (k) {
    var b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-label', k);
    b.style.background = 'linear-gradient(135deg,' + ACCENTS[k][0] + ',' + ACCENTS[k][1] + ')';
    if (k === S.accent) b.className = 'on';
    b.addEventListener('click', function () { S.accent = k; save(); apply(); });
    sw.appendChild(b);
  });
  var l = $('tlist'); l.innerHTML = '';
  S.tiles.forEach(function (t, idx) {
    var d = document.createElement('div'); d.className = 'item';
    var s = document.createElement('span'); s.textContent = t.n + ' — ' + t.u.replace(/^https?:\/\//, '');
    var b = document.createElement('button'); b.type = 'button'; b.textContent = '✕'; b.setAttribute('aria-label', 'Remover');
    b.addEventListener('click', function () { S.tiles.splice(idx, 1); save(); apply(); });
    d.appendChild(s); d.appendChild(b); l.appendChild(d);
  });
}

function openPanel(on) {
  $('panel').classList.toggle('on', on); $('ov').classList.toggle('on', on);
  $('panel').setAttribute('aria-hidden', on ? 'false' : 'true');
}
$('open').onclick = function () { openPanel(true); };
$('close').onclick = $('ov').onclick = function () { openPanel(false); };
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') openPanel(false); });
$('clock').onchange = function () { S.clock = this.checked; save(); apply(); };
$('newtab').onchange = function () { S.newtab = this.checked; save(); };
$('tadd').onclick = function () {
  var n = $('tn').value.trim(), u = $('tu').value.trim();
  if (!n || !u) { toast('Preenche o nome e o endereço'); return; }
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { new URL(u); } catch (e) { toast('Endereço inválido'); return; }
  if (S.tiles.length >= 16) { toast('Máximo de 16 atalhos'); return; }
  S.tiles.push({ n: n, u: u }); $('tn').value = ''; $('tu').value = ''; save(); apply(); toast('Atalho adicionado');
};
$('reset').onclick = function () {
  if (!confirm('Repor todas as definições?')) return;
  try { localStorage.removeItem('veil_settings'); } catch (e) {}
  S = load(); apply(); toast('Definições repostas');
};
$('f').addEventListener('submit', function (e) {
  e.preventDefault(); $('err').textContent = '';
  var v = $('u').value; if (!v.trim()) return;
  go(normalize(v));
});

S = load(); apply();
</script>
</body>
</html>
`;

const INJECT_JS = String.raw`// Injetado em todas as páginas proxyadas.
(function () {
  var PROXPATH = /^\/p\/(https?)\/([^\/]+)(\/.*)?$/;
  var m = location.pathname.match(PROXPATH);
  if (!m) return;
  var scheme = m[1], host = m[2], hostNoPort = host.replace(/:\d+$/, '');
  var self = location.hostname;

  // O site vê o caminho real (/login em vez de /p/https/site/login) -> routers de SPA funcionam
  try { history.replaceState(history.state, '', (m[3] || '/') + location.search + location.hash); } catch (e) {}

  function blocked(h) {
    h = h.toLowerCase();
    return h === self || h.indexOf(':') > -1 || h.indexOf('.') < 0 ||
      /\.(local|localhost|internal|onion|lan|home|corp)$/.test(h) ||
      /^(0|10|127)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(h);
  }
  function skip(s) { return !s || s.charAt(0) === '#' || /^(data|blob|javascript|mailto|tel|about):/i.test(s); }

  function prox(u) {
    try {
      if (u == null) return u;
      u = String(u);
      if (skip(u)) return u;
      var a = new URL(u, location.href);
      if (!/^https?:$/.test(a.protocol)) return u;
      if (a.origin === location.origin) {
        if (PROXPATH.test(a.pathname) || a.pathname === '/inject.js') return a.pathname + a.search + a.hash;
        return '/p/' + scheme + '/' + host + a.pathname + a.search + a.hash;
      }
      if (blocked(a.hostname)) return u;
      return '/p/' + a.protocol.slice(0, -1) + '/' + a.host + a.pathname + a.search + a.hash;
    } catch (e) { return u; }
  }
  // caminho "real" quando o destino é o site atual (histórico e links)
  function real(u) {
    try {
      if (u == null) return u;
      var s = String(u);
      if (skip(s)) return s;
      var a = new URL(s, location.href);
      if (a.origin === location.origin) {
        var pm = a.pathname.match(PROXPATH);
        if (pm) return pm[2] === host ? (pm[3] || '/') + a.search + a.hash : s;
        return a.pathname + a.search + a.hash;
      }
      if (a.host === host || a.hostname === hostNoPort) return a.pathname + a.search + a.hash;
    } catch (e) {}
    return prox(u);
  }
  function navHref(u) {
    var r = real(u);
    return (typeof r === 'string' && r.split(/[?#]/)[0] === '/') ? prox(u) : r;
  }

  // usado pelos redirecionamentos reescritos no servidor (location.replace/assign/href)
  window.__veil = {
    replace: function (u) { location.replace(prox(u)); },
    assign: function (u) { location.assign(prox(u)); },
    get href() { return location.href; },
    set href(u) { location.href = prox(u); }
  };

  // fetch / XHR / beacon / window.open
  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === 'string' || (window.URL && input instanceof URL)) input = prox(input);
    else if (input && input.url) input = new Request(prox(input.url), input);
    return _fetch.call(this, input, init);
  };
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) { arguments[1] = prox(url); return _open.apply(this, arguments); };
  if (navigator.sendBeacon) {
    var _beacon = navigator.sendBeacon;
    navigator.sendBeacon = function (u, d) { return _beacon.call(navigator, prox(u), d); };
  }
  var _wopen = window.open;
  window.open = function (u) { arguments[0] = navHref(u); return _wopen.apply(window, arguments); };

  // atributos
  var URL_ATTRS = { src: 1, href: 1, action: 1, poster: 1, 'data-src': 1 };
  var _set = Element.prototype.setAttribute, _get = Element.prototype.getAttribute;
  function isNav(el) { return el.tagName === 'A' || el.tagName === 'AREA'; }
  Element.prototype.setAttribute = function (n, v) {
    var ln = String(n).toLowerCase();
    if (URL_ATTRS[ln] && typeof v === 'string') v = (ln === 'href' && isNav(this)) ? navHref(v) : prox(v);
    return _set.call(this, n, v);
  };
  [
    [HTMLScriptElement, 'src'], [HTMLImageElement, 'src'], [HTMLIFrameElement, 'src'],
    [HTMLSourceElement, 'src'], [HTMLMediaElement, 'src'], [HTMLLinkElement, 'href'],
    [HTMLAnchorElement, 'href'], [HTMLFormElement, 'action']
  ].forEach(function (p) {
    var d = Object.getOwnPropertyDescriptor(p[0].prototype, p[1]);
    if (!d || !d.set) return;
    var nav = p[0] === HTMLAnchorElement;
    Object.defineProperty(p[0].prototype, p[1], {
      get: d.get,
      set: function (v) { d.set.call(this, nav ? navHref(v) : prox(v)); },
      configurable: true, enumerable: d.enumerable
    });
  });

  // histórico
  ['pushState', 'replaceState'].forEach(function (k) {
    var o = history[k];
    history[k] = function (s, t, u) { return o.call(this, s, t, u == null ? u : real(u)); };
  });

  // cookies do site (isolados por site)
  var cd = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  try {
    var key = (function () {
      var p = hostNoPort.toLowerCase().split('.');
      if (p.length <= 2) return p.join('.');
      var n = (p[p.length - 1].length === 2 && /^(co|com|org|net|gov|edu|ac|or|ne|go)$/.test(p[p.length - 2])) ? 3 : 2;
      return p.slice(-n).join('.');
    })();
    var pre = 'v!' + key + '!';
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: function () {
        return cd.get.call(document).split(/;\s*/).filter(function (c) { return c.indexOf(pre) === 0; })
          .map(function (c) { return c.slice(pre.length); }).join('; ');
      },
      set: function (v) {
        v = String(v).replace(/;\s*domain=[^;]*/ig, '').replace(/;\s*path=[^;]*/ig, '');
        cd.set.call(document, pre + v + '; Path=/');
      }
    });
  } catch (e) {}

  // Cada aba reivindica o seu site quando é usada (várias abas de sites diferentes)
  if (window === window.top && cd) {
    var ctxVal = encodeURIComponent(scheme + '://' + host);
    var claim = function () {
      try {
        var cur = (cd.get.call(document).match(/(?:^|;\s*)veil_site=([^;]*)/) || [])[1];
        if (cur !== ctxVal) cd.set.call(document, 'veil_site=' + ctxVal + '; Path=/; Secure; SameSite=Lax; Max-Age=86400');
      } catch (e) {}
    };
    claim();
    ['pointerdown', 'touchstart', 'keydown', 'focus'].forEach(function (ev) { window.addEventListener(ev, claim, true); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) claim(); });
    window.addEventListener('pageshow', claim);
  }

  // Service Workers do site podiam sequestrar o proxy
  try {
    if (navigator.serviceWorker) {
      Object.defineProperty(ServiceWorkerContainer.prototype, 'register', {
        value: function () { return Promise.reject(new Error('Service workers desativados')); }, configurable: true
      });
    }
  } catch (e) {}

  // conteúdo inserido dinamicamente
  function fix(el) {
    if (!el || el.nodeType !== 1) return;
    for (var k in URL_ATTRS) {
      var v = _get.call(el, k);
      if (!v) continue;
      var n = (k === 'href' && isNav(el)) ? navHref(v) : prox(v);
      if (n !== v) _set.call(el, k, n);
    }
  }
  new MutationObserver(function (muts) {
    muts.forEach(function (mu) {
      mu.addedNodes.forEach(function (node) {
        fix(node);
        if (node.querySelectorAll) node.querySelectorAll('[src],[href],[action],[poster],[data-src]').forEach(fix);
      });
    });
  }).observe(document, { childList: true, subtree: true });
})();
`;

export default {
  async fetch(request) {
    const reqUrl = new URL(request.url);
    const path = reqUrl.pathname;
    if (path === '/' || path === '/index.html')
      return new Response(INDEX_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (path === '/inject.js')
      return new Response(INJECT_JS, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' } });
    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (path === '/_clear') {
      const hd = new Headers({ location: '/' });
      (request.headers.get('cookie') || '').split(/;\s*/).forEach(c => {
        const n = c.split('=')[0];
        if (n.startsWith('v!') || n === 'veil_site') hd.append('set-cookie', n + '=; Max-Age=0; Path=/; Secure');
      });
      return new Response(null, { status: 302, headers: hd });
    }
    const m = path.match(PROXY_PATH);
    if (m) return proxy(request, reqUrl, m);
    return fallback(request, reqUrl);
  }
};
