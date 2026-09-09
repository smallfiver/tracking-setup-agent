// Testa o snippet de verdade (worker/snippet.js) num sandbox de navegador
// minimo, via vm — nao um clone da logica. Se o arquivo real mudar, o teste
// muda de resultado, nao so a copia.
import fs from 'fs';
import vm from 'vm';
import assert from 'assert';

let failures = 0;
function show(label, ok, extra = '') {
  console.log(`  ${ok ? 'OK   ' : 'FALHA'} | ${label}${extra ? ' -> ' + extra : ''}`);
  if (!ok) failures++;
}

const SOURCE = fs.readFileSync(new URL('../worker/snippet.js', import.meta.url), 'utf-8');

const PRODUCT_LIST = [
  {
    name: 'Protocolo de Gênesis',
    match: ['ae90d789-391c-4922-83f0-00b87673ae27', 'codificadorangelical', 'protocolo de genesis', 'protocolo de gênesis']
  },
  { name: 'Genesis Protocol EN', match: ['PPU38CQC5UT', 'protocolodelgenesis'] },
  { name: 'Capítulo Secreto', match: ['capitulo secreto', 'capítulo secreto'] }
];

/** Carrega o snippet real num DOM falso e devolve o product_name do primeiro landing/page_view enviado. */
function rodarSnippet({ url, referrer = '', title = '', trackPageViews = false }) {
  const cookies = {};
  const beacons = [];

  const fakeDocument = {
    referrer,
    title,
    cookie: '',
    readyState: 'complete',
    documentElement: {},
    addEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementsByTagName: () => [],
    createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {} })
  };
  Object.defineProperty(fakeDocument, 'cookie', {
    get: () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
    set: (v) => {
      const [pair] = String(v).split(';');
      const eq = pair.indexOf('=');
      if (eq > -1) cookies[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  });

  const sandbox = {
    window: {},
    document: fakeDocument,
    location: new URL(url),
    navigator: {
      sendBeacon: (endpoint, blob) => {
        beacons.push({ endpoint, body: blob.__body });
        return true;
      },
      userAgent: 'Mozilla/5.0 (test)'
    },
    fetch: () => Promise.resolve(),
    Blob: function (parts) { this.__body = parts[0]; },
    MutationObserver: function () { this.observe = () => {}; },
    URLSearchParams,
    URL,
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    Date,
    Math,
    JSON,
    encodeURIComponent,
    decodeURIComponent,
    RegExp,
    __PRODUCT_LIST__: PRODUCT_LIST
  };
  sandbox.window.dataLayer = [];
  sandbox.window.localStorage = (() => {
    const store = {};
    return {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    };
  })();
  sandbox.window.sessionStorage = sandbox.window.localStorage
    ? (() => {
        const store = {};
        return {
          getItem: (k) => (k in store ? store[k] : null),
          setItem: (k, v) => { store[k] = String(v); },
          removeItem: (k) => { delete store[k]; }
        };
      })()
    : undefined;
  sandbox.navigator.sendBeacon.bind(sandbox.navigator);
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;

  const prepared = SOURCE
    .replace("'__ENDPOINT__'", "'https://track.test'")
    .replace("'__TRACK_PV__' === 'true'", trackPageViews ? 'true' : 'false')
    .replace("'__TRACK_ENGAGEMENT__' === 'true'", 'false')
    .replace("'__CHECKOUT_DOMAINS__'", "''")
    .replace('__PRODUCT_LIST__', 'window.__PRODUCT_LIST__');

  sandbox.window.__PRODUCT_LIST__ = PRODUCT_LIST;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(prepared, ctx, { filename: 'snippet.js' });

  const evento = beacons.find((b) => {
    try {
      const p = JSON.parse(b.body);
      return p.event_name === (trackPageViews ? 'page_view' : 'landing');
    } catch {
      return false;
    }
  });
  return evento ? JSON.parse(evento.body).product_name || null : null;
}

console.log('\n=== Snippet real: resolveProduct — URL vence titulo desatualizado ===');
{
  // O bug de producao: landing em ingles clonada da landing em portugues,
  // title esquecido em portugues. A URL/dominio dizem "Genesis Protocol EN";
  // o title (errado) diz "Protocolo de Genesis".
  const produto = rodarSnippet({
    url: 'https://protocolodelgenesis.lovable.app/vsl?utm_source=x',
    referrer: 'https://protocolodelgenesis.lovable.app/?utm_source=x',
    title: 'Protocolo de Genesis', // title desatualizado, em portugues
    trackPageViews: true
  });
  show('URL do dominio vence o title desatualizado', produto === 'Genesis Protocol EN', String(produto));
}

console.log('\n=== Snippet real: title ainda serve quando URL nao diz nada ===');
{
  const produto = rodarSnippet({
    url: 'https://minhalanding.exemplo.com/vsl',
    referrer: '',
    title: 'Capítulo Secreto - VSL',
    trackPageViews: true
  });
  show('sem sinal na URL, cai para o title', produto === 'Capítulo Secreto', String(produto));
}

console.log('\n=== Snippet real: URL do proprio produto ainda funciona ===');
{
  const produto = rodarSnippet({
    url: 'https://codificadorangelical.trafegopago93.shop/vsl',
    title: '',
    trackPageViews: true
  });
  show('token no dominio resolve certo', produto === 'Protocolo de Gênesis', String(produto));
}

console.log('\n' + (failures ? 'HOUVE FALHAS' : 'TODOS OS TESTES PASSARAM'));
process.exitCode = failures ? 1 : 0;
