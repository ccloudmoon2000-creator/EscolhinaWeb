// Veil — proxy do Roblox num único Cloudflare Worker (colar no editor do painel).
// Serve a página inicial (/), o script cliente (/inject.js) e o proxy (/p/...).

// URL do proxy: /p/<https|http>/<host>/<caminho>?<query>
// Só permite domínios do Roblox (evita que o proxy seja usado como proxy aberto).

const ALLOW = /(^|\.)(roblox\.com|rbxcdn\.com|robloxlabs\.com)$/i;

const STRIP_RESPONSE = [
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'strict-transport-security', 'content-length',
  'report-to', 'nel'
];

function prox(v, base) {
  try {
    if (v == null) return v;
    v = String(v).trim();
    if (!v || v.startsWith('#')) return v;
    const a = new URL(v, base);
    if (!/^https?:$/.test(a.protocol)) return v;          // data:, javascript:, mailto:...
    if (!ALLOW.test(a.hostname)) return a.href;            // fora do Roblox: link direto
    return '/p/' + a.protocol.slice(0, -1) + '/' + a.host + a.pathname + a.search + a.hash;
  } catch { return v; }
}

function fixCookie(c) {
  return c
    .replace(/;\s*Domain=[^;]*/ig, '')
    .replace(/;\s*SameSite=None/ig, '; SameSite=Lax');
}

class Rewrite {
  constructor(base) { this.base = base; }
  element(el) {
    for (const a of ['href', 'src', 'action', 'poster', 'data-src']) {
      const v = el.getAttribute(a);
      if (v !== null) el.setAttribute(a, prox(v, this.base));
    }
    const ss = el.getAttribute('srcset');
    if (ss) {
      el.setAttribute('srcset', ss.split(',').map(p => {
        const [u, ...d] = p.trim().split(/\s+/);
        return [prox(u, this.base), ...d].join(' ');
      }).join(', '));
    }
    el.removeAttribute('integrity');
  }
}

async function proxy(request) {
  const reqUrl = new URL(request.url);
  const m = reqUrl.pathname.match(/^\/p\/(https?)\/([^/]+)(\/.*)?$/);
  if (!m) return new Response('Formato: /p/https/www.roblox.com/', { status: 400 });

  const host = m[2];
  if (!ALLOW.test(host)) return new Response('Domínio não permitido', { status: 403 });

  const target = new URL('https://' + host + (m[3] || '/') + reqUrl.search);

  // Cabeçalhos para o Roblox
  const h = new Headers(request.headers);
  for (const k of [...h.keys()]) {
    if (k.startsWith('cf-') || k.startsWith('sec-fetch-') || k.startsWith('x-forwarded-')) h.delete(k);
  }
  ['host', 'x-real-ip', 'cdn-loop'].forEach(k => h.delete(k));
  h.set('referer', target.origin + '/');
  if (!['GET', 'HEAD'].includes(request.method)) h.set('origin', target.origin);

  let res;
  try {
    res = await fetch(target.href, {
      method: request.method,
      headers: h,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual'
    });
  } catch (e) {
    return new Response('Erro ao contactar o Roblox: ' + e.message, { status: 502 });
  }

  const out = new Headers(res.headers);
  STRIP_RESPONSE.forEach(k => out.delete(k));

  // Cookies: remove Domain para ficarem no teu domínio
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  out.delete('set-cookie');
  cookies.forEach(c => out.append('set-cookie', fixCookie(c)));

  // Redirecionamentos
  const loc = out.get('location');
  if (loc) out.set('location', prox(loc, target.href));

  const type = out.get('content-type') || '';

  if (type.includes('text/html')) {
    out.delete('content-encoding');
    return new HTMLRewriter()
      .on('meta[http-equiv]', { element(e) {
        if (/content-security-policy/i.test(e.getAttribute('http-equiv'))) e.remove();
      } })
      .on('base', { element(e) { e.remove(); } })
      .on('*', new Rewrite(target.href))
      .on('head', { element(e) { e.prepend('<script src="/inject.js"></script>', { html: true }); } })
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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Veil — Roblox</title>
<style>
  :root{--bg:#0b0b14;--panel:#14142a;--line:#26264a;--text:#e8e8f5;--muted:#8c8cb0;--blue:#4f8cff;--purple:#8b5cf6}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 30% 20%,#1a1740,var(--bg) 60%);color:var(--text);font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif}
  .card{width:min(560px,92vw);background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:32px;text-align:center}
  h1{margin:0 0 6px;font-size:42px;letter-spacing:1px;background:linear-gradient(90deg,var(--blue),var(--purple));-webkit-background-clip:text;background-clip:text;color:transparent}
  p{color:var(--muted);margin:0 0 20px}
  form{display:flex;gap:8px}
  input{flex:1;min-width:0;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:12px 14px;font:inherit;outline:none}
  input:focus{border-color:var(--purple)}
  button{border:0;border-radius:10px;padding:12px 18px;font:inherit;color:#fff;cursor:pointer;background:linear-gradient(90deg,var(--blue),var(--purple))}
  .quick{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:16px}
  .quick a{color:var(--text);text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:13px}
  .quick a:hover{border-color:var(--purple)}
  .note{margin-top:22px;font-size:12px;color:var(--muted)}
  #err{color:#ff7b8a;margin-top:10px;min-height:1.2em;font-size:13px}
</style>
</head>
<body>
<div class="card">
  <h1>VEIL</h1>
  <p>Abre o site do Roblox através do Cloudflare.</p>
  <form id="f">
    <input id="u" placeholder="roblox.com/games" autocomplete="off" spellcheck="false">
    <button>Abrir</button>
  </form>
  <div id="err"></div>
  <div class="quick">
    <a href="/p/https/www.roblox.com/home">Início</a>
    <a href="/p/https/www.roblox.com/discover">Jogos</a>
    <a href="/p/https/www.roblox.com/catalog">Catálogo</a>
    <a href="/p/https/create.roblox.com/">Create</a>
  </div>
  <div class="note">Só domínios do Roblox. O Roblox Player (jogar) não funciona por proxy.</div>
</div>
<script>
document.getElementById('f').addEventListener('submit', function (e) {
  e.preventDefault();
  var v = document.getElementById('u').value.trim();
  var err = document.getElementById('err');
  err.textContent = '';
  if (!v) return;
  if (!/^https?:\/\//i.test(v)) v = 'https://' + (/^[\w-]+(\.[\w-]+)+/.test(v) ? v : 'www.roblox.com/' + v.replace(/^\//, ''));
  try {
    var u = new URL(v);
    if (!/(^|\.)(roblox\.com|rbxcdn\.com|robloxlabs\.com)$/i.test(u.hostname)) { err.textContent = 'Só endereços do Roblox são permitidos.'; return; }
    location.href = '/p/' + u.protocol.slice(0, -1) + '/' + u.host + u.pathname + u.search + u.hash;
  } catch (x) { err.textContent = 'Endereço inválido.'; }
});
</script>
</body>
</html>
`;

const INJECT_JS = String.raw`// Injetado em todas as páginas proxyadas. Faz com que JS pesado (SPAs) continue
// a falar com o Roblox através do proxy, em vez de ir direto e falhar por CORS.
(function () {
  var ALLOW = /(^|\.)(roblox\.com|rbxcdn\.com|robloxlabs\.com)$/i;
  var m = location.pathname.match(/^\/p\/(https?)\/([^\/]+)/);
  if (!m) return;

  function prox(u) {
    try {
      if (u == null) return u;
      u = String(u);
      if (!u || u.charAt(0) === '#' || /^(data|blob|javascript|mailto|tel|about):/i.test(u)) return u;
      var a = new URL(u, location.href);
      if (a.origin === location.origin) {
        if (a.pathname.indexOf('/p/') === 0 || a.pathname === '/inject.js') return a.pathname + a.search + a.hash;
        return '/p/' + m[1] + '/' + m[2] + a.pathname + a.search + a.hash; // caminho absoluto -> site atual
      }
      if (/^https?:$/.test(a.protocol) && ALLOW.test(a.hostname)) {
        return '/p/' + a.protocol.slice(0, -1) + '/' + a.host + a.pathname + a.search + a.hash;
      }
      return u;
    } catch (e) { return u; }
  }

  // fetch
  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === 'string' || (window.URL && input instanceof URL)) input = prox(input);
    else if (input && input.url) input = new Request(prox(input.url), input);
    return _fetch.call(this, input, init);
  };

  // XMLHttpRequest
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    arguments[1] = prox(url);
    return _open.apply(this, arguments);
  };

  // sendBeacon / window.open
  if (navigator.sendBeacon) {
    var _beacon = navigator.sendBeacon;
    navigator.sendBeacon = function (u, d) { return _beacon.call(navigator, prox(u), d); };
  }
  var _wopen = window.open;
  window.open = function (u) { arguments[0] = prox(u); return _wopen.apply(window, arguments); };

  // setAttribute
  var URL_ATTRS = { src: 1, href: 1, action: 1, poster: 1, 'data-src': 1 };
  var _set = Element.prototype.setAttribute;
  var _get = Element.prototype.getAttribute;
  Element.prototype.setAttribute = function (n, v) {
    if (URL_ATTRS[String(n).toLowerCase()] && typeof v === 'string') v = prox(v);
    return _set.call(this, n, v);
  };

  // propriedades (img.src = ..., script.src = ..., etc.)
  [
    [HTMLScriptElement, 'src'], [HTMLImageElement, 'src'], [HTMLIFrameElement, 'src'],
    [HTMLSourceElement, 'src'], [HTMLMediaElement, 'src'], [HTMLLinkElement, 'href'],
    [HTMLAnchorElement, 'href'], [HTMLFormElement, 'action']
  ].forEach(function (p) {
    var d = Object.getOwnPropertyDescriptor(p[0].prototype, p[1]);
    if (!d || !d.set) return;
    Object.defineProperty(p[0].prototype, p[1], {
      get: d.get,
      set: function (v) { d.set.call(this, prox(v)); },
      configurable: true,
      enumerable: d.enumerable
    });
  });

  // history (SPAs)
  ['pushState', 'replaceState'].forEach(function (k) {
    var o = history[k];
    history[k] = function (s, t, u) { return o.call(this, s, t, u == null ? u : prox(u)); };
  });

  // HTML inserido dinamicamente (innerHTML, frameworks...)
  function fix(el) {
    if (!el || el.nodeType !== 1) return;
    for (var k in URL_ATTRS) {
      var v = _get.call(el, k);
      if (v) { var n = prox(v); if (n !== v) _set.call(el, k, n); }
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
    const { pathname } = new URL(request.url);
    if (pathname === '/' || pathname === '/index.html')
      return new Response(INDEX_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (pathname === '/inject.js')
      return new Response(INJECT_JS, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' } });
    if (pathname.startsWith('/p/')) return proxy(request);
    return new Response('Não encontrado', { status: 404 });
  }
};
