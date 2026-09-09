/**
 * Snippet de rastreamento first-party.
 * Servido pelo proprio Worker em <worker>/t.js — basta um <script src> no site.
 *
 * O que ele resolve:
 *  - persiste gclid/gbraid/wbraid/fbclid/ttclid/msclkid e UTMs por 90 dias,
 *    para que o clique sobreviva ate o checkout (que costuma ser outro dominio);
 *  - gera um ID de visitante proprio (tsid) que costura navegacao -> venda;
 *  - le os cookies _fbc/_fbp/_ga do Facebook e do GA4;
 *  - captura dados do cliente em formularios e no dataLayer;
 *  - envia tudo para o endpoint /collect.
 *
 * API publica:
 *   tsTrack('begin_checkout', { value: 197, currency: 'BRL', customer: { email } })
 *   tsIdentify({ email, phone, name })
 *   tsData()   -> devolve o objeto de atribuicao atual (util para debug)
 */
(function () {
  var ENDPOINT = '__ENDPOINT__';
  var TRACK_PAGE_VIEWS = '__TRACK_PV__' === 'true';
  // Liga a captura de watch-time da VSL e de tempo na pagina. Fica atras de um
  // interruptor porque sao os eventos mais frequentes do sistema, e o D1 no
  // plano gratuito tem teto de escrita.
  var TRACK_ENGAGEMENT = '__TRACK_ENGAGEMENT__' === 'true';

  var STORAGE_KEY = '_ts_attr';
  var ID_KEY = '_tsid';
  var TTL_DAYS = 90;

  var CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid'];
  var UTMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

  /* ---------------------------------------------------------------- */

  function now() { return new Date().getTime(); }

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function readCookie(name) {
    var match = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return match ? decodeURIComponent(match[2]) : null;
  }

  /**
   * Grava o cookie no dominio mais amplo que o navegador aceitar.
   *
   * O ideal e o dominio raiz (".cliente.com"), para o cookie sobreviver entre
   * subdominios. Mas "os dois ultimos rotulos" nem sempre e um dominio raiz:
   * em hospedagens como lovable.app, vercel.app ou com.br, isso da um sufixo
   * publico — e o navegador descarta o cookie em silencio, sem erro nenhum.
   *
   * Em vez de carregar a lista de sufixos publicos, tentamos e conferimos: se o
   * cookie nao aparecer, regravamos preso ao host atual, que sempre funciona.
   */
  function writeCookie(name, value, days) {
    var expires = new Date(now() + days * 864e5).toUTCString();
    var base = name + '=' + encodeURIComponent(value) + '; expires=' + expires + '; path=/; SameSite=Lax';

    var host = location.hostname.split('.');
    if (host.length > 2) {
      document.cookie = base + '; domain=.' + host.slice(-2).join('.');
      if (readCookie(name) === String(value)) return;
    }

    document.cookie = base;
  }

  function readStore(key) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeStore(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* modo privado */ }
  }

  /* -------------------- identidade do visitante -------------------- */

  function getVisitorId() {
    var id = readCookie(ID_KEY) || (readStore(ID_KEY) || {}).v;
    if (!id) id = uuid();
    writeCookie(ID_KEY, id, 365);
    writeStore(ID_KEY, { v: id });
    return id;
  }

  /** client_id do GA4 vem no cookie _ga: GA1.1.<cid1>.<cid2> */
  function getGaClientId() {
    var ga = readCookie('_ga');
    if (!ga) return null;
    var parts = ga.split('.');
    return parts.length >= 4 ? parts[2] + '.' + parts[3] : null;
  }

  /* ----------------------- atribuicao ------------------------------ */

  function paramsFromUrl() {
    var qs = new URLSearchParams(location.search);
    var out = {};
    CLICK_IDS.concat(UTMS).forEach(function (key) {
      var v = qs.get(key);
      if (v) out[key] = v;
    });
    return out;
  }

  /**
   * _fbc e um cookie do pixel. Se o pixel ainda nao rodou mas ha fbclid na URL,
   * montamos o valor no formato que a API de Conversoes espera.
   */
  function resolveFbc(fbclid) {
    var cookie = readCookie('_fbc');
    if (cookie) return cookie;
    if (!fbclid) return null;
    return 'fb.1.' + now() + '.' + fbclid;
  }

  function loadAttribution() {
    var stored = readStore(STORAGE_KEY) || {};
    var fresh = paramsFromUrl();
    var expired = stored.ts && now() - stored.ts > TTL_DAYS * 864e5;
    if (expired) stored = {};

    var hasNewClick = CLICK_IDS.concat(UTMS).some(function (k) { return !!fresh[k]; });

    var attr = {};
    CLICK_IDS.concat(UTMS).forEach(function (key) {
      // Ultimo clique vence: parametro novo na URL sobrescreve o guardado.
      attr[key] = fresh[key] || stored[key] || null;
    });

    attr.first_referrer = stored.first_referrer || document.referrer || null;
    attr.first_landing = stored.first_landing || location.href;
    attr.ts = hasNewClick || !stored.ts ? now() : stored.ts;

    writeStore(STORAGE_KEY, attr);
    return attr;
  }

  /* -------------------- dados do cliente --------------------------- */

  var identity = readStore('_ts_person') || {};

  function mergeIdentity(person) {
    if (!person) return;
    ['email', 'phone', 'name', 'document', 'city', 'state', 'zip', 'country'].forEach(function (k) {
      if (person[k]) identity[k] = String(person[k]).trim();
    });
    writeStore('_ts_person', identity);
  }

  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  /** Varre um formulario procurando email/telefone/nome sem depender de IDs fixos. */
  function harvestForm(form) {
    var person = {};
    var inputs = form.querySelectorAll('input, select, textarea');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var value = (el.value || '').trim();
      if (!value || el.type === 'password' || el.type === 'hidden') continue;
      var hint = ((el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '') + ' ' + (el.type || '')).toLowerCase();

      if (EMAIL_RE.test(value) || hint.indexOf('email') > -1 || hint.indexOf('mail') > -1) {
        if (EMAIL_RE.test(value)) person.email = value;
      } else if (hint.indexOf('phone') > -1 || hint.indexOf('tel') > -1 || hint.indexOf('celular') > -1 || hint.indexOf('whats') > -1) {
        person.phone = value;
      } else if (hint.indexOf('cpf') > -1 || hint.indexOf('document') > -1 || hint.indexOf('cnpj') > -1) {
        person.document = value;
      } else if (hint.indexOf('name') > -1 || hint.indexOf('nome') > -1) {
        person.name = value;
      } else if (hint.indexOf('cep') > -1 || hint.indexOf('zip') > -1) {
        person.zip = value;
      } else if (hint.indexOf('city') > -1 || hint.indexOf('cidade') > -1) {
        person.city = value;
      } else if (hint.indexOf('state') > -1 || hint.indexOf('estado') > -1 || hint.indexOf('uf') === 0) {
        person.state = value;
      }
    }
    return person;
  }

  /* ------------------------ envio ---------------------------------- */

  var attribution = loadAttribution();
  var visitorId = getVisitorId();
  var sessionId = (function () {
    var s = window.sessionStorage && window.sessionStorage.getItem('_ts_sid');
    if (!s) {
      s = String(now());
      try { window.sessionStorage.setItem('_ts_sid', s); } catch (e) {}
    }
    return s;
  })();

  function buildPayload(eventName, data) {
    data = data || {};
    mergeIdentity(data.customer);

    var payload = {
      event_name: eventName,
      event_id: data.event_id || uuid(),
      tsid: visitorId,
      client_id: getGaClientId(),
      session_id: sessionId,
      page_location: location.href,
      page_referrer: document.referrer || null,
      page_title: document.title,
      transaction_id: data.transaction_id || null,
      value: data.value !== undefined ? data.value : null,
      currency: data.currency || 'BRL',
      items: data.items || null,
      fbc: resolveFbc(attribution.fbclid),
      fbp: readCookie('_fbp'),
      customer: identity
    };

    CLICK_IDS.concat(UTMS).forEach(function (key) {
      payload[key] = attribution[key] || null;
    });

    // Campos extras informados pelo chamador seguem junto.
    Object.keys(data).forEach(function (k) {
      if (payload[k] === undefined && k !== 'customer') payload[k] = data[k];
    });

    return payload;
  }

  /**
   * Eventos de engajamento: vao para o GA4 (via dataLayer) mas nao para o D1.
   *
   * Sao os de maior volume — chegaram a 25 mil por hora e encheram o banco de
   * 10 GB em poucos dias, derrubando o rastreamento inteiro. No GA4 eles nao
   * pesam e ainda sustentam os publicos de VSL; no D1 nao alimentam nenhuma
   * tela do painel. Por isso a montagem do payload continua igual, so o envio
   * para /collect e pulado.
   */
  var SO_PARA_GA4 = { time_on_page: 1, video_progress: 1, video_start: 1, video_complete: 1, scroll: 1, user_engagement: 1 };

  function send(eventName, data) {
    var payload = buildPayload(eventName, data);
    if (SO_PARA_GA4[eventName]) return payload;
    var body = JSON.stringify(payload);
    var url = ENDPOINT + '/collect';

    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
        return payload;
      }
    } catch (e) { /* cai no fetch */ }

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      keepalive: true,
      credentials: 'omit'
    }).catch(function () {});

    return payload;
  }

  /* ------------------- integracao com o dataLayer ------------------- */

  var MIRRORED = {
    view_item: 1, view_content: 1, add_to_cart: 1, initiate_checkout: 1,
    InitiateCheckout: 1, begin_checkout: 1, add_payment_info: 1,
    generate_lead: 1, purchase: 1, sign_up: 1, contact: 1, view_item_list: 1
  };

  function fromDataLayer(entry) {
    if (!entry || !entry.event || !MIRRORED[entry.event]) return;
    // Evita eco: o que nos mesmos empurramos nao volta como evento novo.
    if (entry._ts_origin === 'snippet') return;
    var eco = entry.ecommerce || {};
    send(entry.event === 'InitiateCheckout' ? 'initiate_checkout' : entry.event, {
      value: eco.value !== undefined ? eco.value : entry.value,
      currency: eco.currency || entry.currency,
      transaction_id: eco.transaction_id || entry.transaction_id,
      items: eco.items || entry.items,
      customer: entry.customer || entry.user_data
    });
  }

  /**
   * Empurra o evento para o dataLayer para que as tags do GA4 no GTM disparem.
   *
   * Sem isto, um evento que o snippet detecta sozinho (o clique no botao da VSL,
   * por exemplo) fica so no nosso banco e o GA4 nunca fica sabendo — e ai os
   * publicos de remarketing criados no GA4 nascem vazios.
   */
  function pushToDataLayer(eventName, payload, data) {
    try {
      window.dataLayer = window.dataLayer || [];
      var entry = {
        event: eventName,
        _ts_origin: 'snippet',
        event_id: payload.event_id,
        tsid: payload.tsid
      };
      if (payload.value !== null && payload.value !== undefined) {
        entry.ecommerce = {
          value: payload.value,
          currency: payload.currency,
          transaction_id: payload.transaction_id,
          items: payload.items || undefined
        };
      }
      // Produto resolvido: garante item_name no dataLayer, que e o que a tag GA4
      // le em {{DL - product_name}} para separar o publico por produto.
      if (payload.product_name) {
        entry.ecommerce = entry.ecommerce || {};
        if (!entry.ecommerce.items || !entry.ecommerce.items.length) {
          entry.ecommerce.items = [
            { item_id: payload.product_id || undefined, item_name: payload.product_name }
          ];
        }
        entry.product_name = payload.product_name;
      }
      if (identity.email || identity.phone) {
        entry.customer = { email: identity.email, phone: identity.phone, name: identity.name };
      }
      if (data && data.checkout_url) entry.checkout_url = data.checkout_url;
      // Marco da VSL: e o parametro que vira a dimensao video_mark no GA4 e,
      // com ela, os publicos de "assistiu ate X minutos".
      if (data && data.video_mark) {
        entry.video_mark = data.video_mark;
        entry.video_seconds = data.video_seconds;
        entry.video_id = data.video_id;
      }
      if (data && data.engagement_type) {
        entry.engagement_type = data.engagement_type;
        entry.engagement_value = data.engagement_value;
      }
      window.dataLayer.push(entry);
    } catch (e) { /* sem dataLayer, seguimos so com o nosso envio */ }
  }

  function hookDataLayer() {
    window.dataLayer = window.dataLayer || [];
    for (var i = 0; i < window.dataLayer.length; i++) fromDataLayer(window.dataLayer[i]);
    var push = window.dataLayer.push;
    window.dataLayer.push = function () {
      for (var i = 0; i < arguments.length; i++) {
        try { fromDataLayer(arguments[i]); } catch (e) {}
      }
      return push.apply(window.dataLayer, arguments);
    };
  }

  /* ------------------- captura automatica --------------------------- */

  function hookForms() {
    document.addEventListener(
      'submit',
      function (e) {
        var form = e.target;
        if (!form || form.tagName !== 'FORM') return;
        var person = harvestForm(form);
        if (person.email || person.phone) {
          mergeIdentity(person);
          var payload = send('generate_lead', { customer: person });
          pushToDataLayer('generate_lead', payload, null);
        }
      },
      true
    );

    // Tambem captura quando o usuario apenas preenche o campo e segue para o checkout.
    document.addEventListener(
      'change',
      function (e) {
        var el = e.target;
        if (!el || !el.value) return;
        var value = String(el.value).trim();
        var hint = ((el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '')).toLowerCase();
        if (EMAIL_RE.test(value)) mergeIdentity({ email: value });
        else if (hint.indexOf('phone') > -1 || hint.indexOf('tel') > -1 || hint.indexOf('celular') > -1) {
          mergeIdentity({ phone: value });
        }
      },
      true
    );
  }

  /** Plataformas de checkout mais comuns no mercado brasileiro. */
  var CHECKOUT_HOSTS =
    /(kirvano|kiwify|hotmart|monetizze|braip|eduzz|perfectpay|centerpag|cartpanda|ticto|greenn|lastlink|pepper|payt|appmax|yampi|doppus|mercadopago|pagseguro|stripe)/i;
  var CHECKOUT_PATH = /(checkout|\/pay|carrinho|comprar|assinar|pagamento|finalizar|inscri)/i;

  /**
   * Dominios extras configurados no painel.
   *
   * Somam-se aos de cima, nunca os substituem — assim um erro de digitacao na
   * configuracao nao derruba o rastreamento de quem ja funciona.
   */
  var CHECKOUT_EXTRA = '__CHECKOUT_DOMAINS__'
    .split(',')
    .map(function (d) {
      return d.trim().toLowerCase();
    })
    .filter(function (d) {
      return d && d.indexOf('__') !== 0;
    });

  /**
   * Lista de produtos (nome + trechos que o identificam na URL), injetada pelo
   * Worker a partir da productList do perfil. Serve para carimbar product_name
   * no checkout — e assim os publicos por produto do GA4 encherem de forma
   * consistente, sem depender do dataLayer do site.
   */
  var PRODUCT_LIST = (function () {
    try { return __PRODUCT_LIST__ || []; } catch (e) { return []; }
  })();

  /** Procura os tokens de todos os produtos num texto; primeiro que casar ganha. */
  function acharProdutoEm(hay) {
    if (!hay) return null;
    for (var i = 0; i < PRODUCT_LIST.length; i++) {
      var prod = PRODUCT_LIST[i];
      var tokens = prod && prod.match ? prod.match : [];
      for (var j = 0; j < tokens.length; j++) {
        var t = String(tokens[j] || '').toLowerCase().trim();
        if (!t) continue;
        // Prefixo "re:" = regex, igual a {{JS - Produto (URL)}} no GTM e ao
        // classificador do Worker — sem isto, um token regex nunca casava aqui
        // (a busca era so substring literal, entao "re:algo" nunca aparecia
        // de verdade na pagina).
        if (t.slice(0, 3) === 're:') {
          try { if (new RegExp(t.slice(3), 'i').test(hay)) return prod.name; } catch (e) {}
          continue;
        }
        if (hay.indexOf(t) > -1) return prod.name;
      }
    }
    return null;
  }

  /**
   * Descobre o produto olhando a URL do checkout, a pagina atual, o referrer e
   * o titulo — nessa ordem de confianca.
   *
   * URL e dominio sao carimbados por nos (o link do checkout, o hostname da
   * landing) e nao mentem. O <title> da pagina e HTML solto que a agencia ou o
   * clonador da landing escreve a mao — e clonar uma pagina em espanhol/ingles
   * a partir de uma em portugues costuma deixar o titulo antigo para tras.
   * Uma landing "Genesis Protocol EN" com titulo esquecido "Protocolo de
   * Genesis" estava vazando ~17% dos eventos para o produto errado porque o
   * titulo entrava na mesma busca que a URL, e o produto errado vinha primeiro
   * na lista. Agora so olhamos o titulo se URL e referrer nao disserem nada.
   */
  function resolveProduct(extra) {
    if (!PRODUCT_LIST.length) return null;
    var porUrl = [extra, location.href, document.referrer].filter(Boolean).join(' ').toLowerCase();
    return acharProdutoEm(porUrl) || acharProdutoEm(String(document.title || '').toLowerCase());
  }

  function ehDominioConfigurado(hostname) {
    var host = String(hostname || '').toLowerCase();
    for (var i = 0; i < CHECKOUT_EXTRA.length; i++) {
      var alvo = CHECKOUT_EXTRA[i];
      // Casa o dominio exato e qualquer subdominio dele.
      if (host === alvo || host.indexOf(alvo) > -1) return true;
    }
    return false;
  }

  function looksLikeCheckout(dest) {
    if (CHECKOUT_HOSTS.test(dest.hostname)) return true;
    if (ehDominioConfigurado(dest.hostname)) return true;
    // Caminho generico (comprar, checkout, oferta...) so conta quando o destino
    // e OUTRO dominio. Assim o botao da pre-venda — um link interno para a VSL —
    // nunca e confundido com o checkout de verdade.
    return dest.hostname !== location.hostname && CHECKOUT_PATH.test(dest.pathname);
  }

  /**
   * A pagina tem um checkout alcancavel? (algum link ou iframe apontando para um
   * host de checkout). Usado para so aceitar a deteccao por TEXTO do botao
   * quando estamos de fato na VSL/checkout — nunca na pre-venda, que nao tem
   * checkout algum na pagina.
   */
  function pageHasCheckout() {
    var els = document.querySelectorAll('a[href], iframe[src]');
    for (var i = 0; i < els.length; i++) {
      var u = els[i].getAttribute('href') || els[i].getAttribute('src') || '';
      if (u.indexOf('http') === 0) {
        try { if (CHECKOUT_HOSTS.test(new URL(u).hostname)) return true; } catch (e) {}
      }
    }
    return false;
  }

  /** Texto tipico de botao de compra em VSL. */
  var BUY_TEXT =
    /(comprar|quero|garantir|adquirir|assinar|inscrever|sim.?eu|acessar agora|liberar|desbloquear|checkout|finalizar|pedido|oferta|aproveitar)/i;

  /**
   * Elemento clicavel de verdade.
   *
   * Players de VSL (VTurb, ConverteAI e similares) injetam o botao dinamicamente
   * e as vezes dentro de shadow DOM, onde closest() nao alcanca. composedPath()
   * devolve o caminho real do clique, atravessando essas fronteiras.
   */
  function clickedElement(e) {
    var path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    for (var i = 0; i < path.length; i++) {
      var el = path[i];
      if (!el || el.nodeType !== 1) continue;
      var tag = (el.tagName || '').toUpperCase();
      if (tag === 'A' && el.getAttribute('href')) return el;
      if (tag === 'BUTTON' || el.getAttribute('role') === 'button') return el;
    }
    return e.target && e.target.closest ? e.target.closest('a[href], button, [role="button"]') : null;
  }

  /**
   * Carimba tsid, click IDs, UTMs e o indexador (email) numa URL de destino.
   * E o que garante que o order bump / upsell / downsell — abertos em outro
   * dominio ou dentro de um iframe — cheguem ao checkout com a atribuicao e com
   * o email, o dado que costura todas as etapas do funil ao mesmo cliente.
   * Devolve a string decorada, ou null se nada mudou.
   */
  function decorateUrl(urlStr) {
    var dest;
    try { dest = new URL(urlStr, location.href); } catch (err) { return null; }
    // So decora saida para outro host (o checkout), nunca a propria pagina.
    if (dest.hostname === location.hostname) return null;

    var changed = false;
    if (!dest.searchParams.get('tsid')) { dest.searchParams.set('tsid', visitorId); changed = true; }
    // O mesmo id tambem vai como utm_id — parametro UTM padrao. As plataformas
    // de checkout repassam os UTMs no webhook, mas descartam parametros
    // proprios como "tsid": nenhum payload recebido ate hoje trazia o tsid de
    // volta. Com utm_id a costura deixa de depender so do gclid, e passa a
    // funcionar tambem para trafego do Meta e organico.
    if (!dest.searchParams.get('utm_id')) { dest.searchParams.set('utm_id', visitorId); changed = true; }
    CLICK_IDS.concat(UTMS).forEach(function (key) {
      if (attribution[key] && !dest.searchParams.get(key)) {
        dest.searchParams.set(key, attribution[key]);
        changed = true;
      }
    });
    if (identity.email && !dest.searchParams.get('email')) {
      dest.searchParams.set('email', identity.email);
      changed = true;
    }
    return changed ? dest.toString() : null;
  }

  var lastCheckoutAt = 0;

  function trackCheckoutIntent(data) {
    // Cliques repetidos no mesmo botao nao viram eventos duplicados.
    if (now() - lastCheckoutAt < 5000) return;
    lastCheckoutAt = now();
    data = data || {};
    // Carimba o produto (pela URL do checkout/pagina) para o GA4 montar publico.
    var prod = resolveProduct(data.checkout_url);
    if (prod && !data.product_name) data.product_name = prod;
    var payload = send('initiate_checkout', data);
    // Espelha no dataLayer para o GA4 tambem registrar (publicos dependem disso).
    pushToDataLayer('initiate_checkout', payload, data);
  }

  /**
   * Um clique so em "comprar" e o unico sinal entre a visita e a venda.
   *
   * O acionador de clique do GTM depende do botao ser um <a href> e de a tag
   * disparar antes da navegacao — o que falha em boa parte das paginas. Aqui a
   * deteccao e propria: qualquer link que pareca checkout vira initiate_checkout,
   * enviado por sendBeacon (que sobrevive a saida da pagina).
   *
   * O mesmo handler propaga tsid e click IDs para o dominio do checkout.
   */
  function hookOutboundLinks() {
    document.addEventListener(
      'click',
      function (e) {
        var el = clickedElement(e);
        if (!el) return;

        var text = (el.textContent || el.getAttribute('aria-label') || '').trim();
        var href = el.tagName && el.tagName.toUpperCase() === 'A' ? el.getAttribute('href') || '' : '';

        // Caso 1: link de verdade — propaga a atribuicao para o outro dominio.
        if (href.indexOf('http') === 0) {
          var dest;
          try { dest = new URL(href); } catch (err) { return; }

          var decorated = decorateUrl(href);
          var isCheckout = looksLikeCheckout(dest);

          if (isCheckout) {
            trackCheckoutIntent({ checkout_url: (decorated || dest.toString()), link_text: text.slice(0, 80) });

            // Alguns players de VSL (VTurb e afins) tem o proprio decorador do
            // link de checkout e o registram depois do nosso: na pratica,
            // qualquer clique aqui virava uma corrida por ultimo a escrever o
            // href, e o deles vencia — apagando tsid/utm_id/click id que
            // tinhamos acabado de carimbar (visto ao vivo: sobrescrito menos
            // de 5ms depois). Em vez de disputar o atributo, assumimos a
            // navegacao: cancelamos o clique nativo e vamos nos direto para a
            // URL que decoramos, imune a qualquer handler que rode depois.
            e.preventDefault();
            location.href = decorated || dest.toString();
            return;
          }

          if (decorated) el.setAttribute('href', decorated);
          return;
        }

        // Caso 2: botao sem href (comum em VSL, onde o player abre o checkout
        // por JavaScript). So aceita quando ha um checkout alcancavel na pagina
        // — na pre-venda, sem checkout, o botao "quero..." e ignorado.
        if (text && text.length < 120 && BUY_TEXT.test(text) && pageHasCheckout()) {
          trackCheckoutIntent({ link_text: text.slice(0, 80), detected_by: 'texto do botao' });
        }
      },
      true
    );
  }

  /**
   * Checkouts embutidos por <iframe> (comum em order bump / upsell na mesma
   * pagina). O src aponta para o dominio da plataforma; carimbamos tsid, click
   * IDs e email nele. Trata iframes que ja estao na pagina e os injetados depois
   * (players de VSL, pop-ups de upsell) via MutationObserver.
   */
  /**
   * Botao de compra da VSL que abre o checkout por JavaScript (window.open, sem
   * <a href>). Interceptamos o window.open: se a URL for de checkout, carimbamos
   * a atribuicao e disparamos initiate_checkout pela URL de DESTINO — preciso, e
   * nunca dispara na pre-venda (que navega no mesmo dominio, sem window.open
   * para um host de checkout).
   */
  function hookWindowOpen() {
    var orig = window.open;
    if (typeof orig !== 'function' || orig.__tsWrapped) return;
    var wrapped = function (url, name, features) {
      try {
        if (url && String(url).indexOf('http') === 0) {
          var dest = new URL(String(url));
          if (looksLikeCheckout(dest)) {
            var decorated = decorateUrl(String(url)) || String(url);
            trackCheckoutIntent({ checkout_url: decorated, detected_by: 'window.open' });
            return orig.call(window, decorated, name, features);
          }
        }
      } catch (e) { /* qualquer erro: segue para o open normal */ }
      return orig.call(window, url, name, features);
    };
    wrapped.__tsWrapped = true;
    try { window.open = wrapped; } catch (e) {}
  }

  function decorateIframe(frame) {
    if (!frame || frame.tagName !== 'IFRAME') return;
    var src = frame.getAttribute('src');
    if (!src || src.indexOf('http') !== 0) return;

    var dest;
    try { dest = new URL(src); } catch (err) { return; }
    if (!looksLikeCheckout(dest)) return;

    var decorated = decorateUrl(src);
    if (decorated && decorated !== src) frame.setAttribute('src', decorated);
  }

  function hookIframes() {
    var frames = document.getElementsByTagName('iframe');
    for (var i = 0; i < frames.length; i++) decorateIframe(frames[i]);

    if (typeof MutationObserver !== 'function') return;
    var observer = new MutationObserver(function (mutations) {
      for (var m = 0; m < mutations.length; m++) {
        var added = mutations[m].addedNodes || [];
        for (var n = 0; n < added.length; n++) {
          var node = added[n];
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'IFRAME') decorateIframe(node);
          else if (node.getElementsByTagName) {
            var inner = node.getElementsByTagName('iframe');
            for (var k = 0; k < inner.length; k++) decorateIframe(inner[k]);
          }
        }
      }
    });
    try { observer.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
  }

  /* --------------------------- API ---------------------------------- */

  window.tsTrack = function (eventName, data) { return send(eventName, data); };
  window.tsIdentify = function (person) {
    mergeIdentity(person);
    return send('identify', { customer: person });
  };
  window.tsData = function () {
    return { tsid: visitorId, session_id: sessionId, attribution: attribution, customer: identity };
  };

  /**
   * Ancora da sessao: uma linha por visita, com tsid, click IDs e UTMs.
   *
   * E ela que permite costurar a venda depois — o webhook da plataforma nao
   * sabe de onde veio o clique, entao precisa existir algum evento gravado com
   * esses dados. Sem isso, quem clica no anuncio e vai direto para o checkout
   * ficaria sem atribuicao nenhuma.
   *
   * Uma linha por sessao (nao por pagina), entao custa pouco no banco.
   */
  function sendLandingOnce() {
    try {
      if (window.sessionStorage.getItem('_ts_landing')) return;
      window.sessionStorage.setItem('_ts_landing', '1');
    } catch (e) {
      // sem sessionStorage, envia a cada carga — ainda assim e pouco
    }
    // Carimba o produto tambem na ancora da visita — sem isto so o checkout
    // sabia o produto, e a visita (o que alimenta os publicos de "Visitante
    // {produto}" no GA4 e as Sessoes por produto no painel) ficava sem.
    var prod = resolveProduct();
    send('landing', prod ? { product_name: prod } : undefined);
  }

  /**
   * Liga a captura automatica. O dataLayer e enganchado de imediato (para nao
   * perder pushes que acontecem cedo); os hooks de DOM esperam a pagina existir.
   */
  /**
   * Grava o produto da pagina num cookie de primeira parte.
   *
   * E dele que a tag do GA4 le o valor para mandar product_name em todo evento
   * — inclusive nos automaticos (page_view, scroll), que o snippet nao controla.
   */
  function marcarProduto() {
    var produto = resolveProduct(null);
    if (produto) writeCookie('_tsprod', produto, 1);
    return produto;
  }

  /* ---------------------- Watch-time da VSL -------------------------- *
   *
   * Numa VSL, o quanto a pessoa assistiu e o sinal mais forte que existe: quem
   * viu 75% e nao comprou e um publico completamente diferente de quem saiu aos
   * 10 segundos — e para o Google Ads sao dois sinais de qualidade distintos.
   *
   * Cobrimos os dois formatos que aparecem nas paginas:
   *
   *   1. <video> nativo — le currentTime/duration direto.
   *   2. Player em iframe (VTurb, ConverteAI) — nao da para ler de fora por
   *      causa da politica de origem cruzada, entao ouvimos o postMessage que
   *      esses players emitem, e caimos para um relogio de permanencia quando
   *      nem isso vem.
   *
   * Cada marco dispara UMA vez por sessao e por video. Sem isso um video de 40
   * minutos geraria centenas de linhas no D1 — e o plano gratuito tem teto.
   */
  /**
   * Marcos em SEGUNDOS ASSISTIDOS, nao em porcentagem.
   *
   * O player da VSL (ConverteAI/VTurb SmartPlayer) nao expoe a duracao do
   * video, entao porcentagem nao da para calcular. E para VSL o tempo absoluto
   * diz mais mesmo: o que interessa e se a pessoa chegou no minuto em que a
   * oferta aparece, nao se viu "50% de um video de duracao desconhecida".
   */
  var MARCOS_SEG = [30, 60, 180, 300, 600, 900, 1200];
  var videoMarks = {};

  function enviarMarcoVideo(chave, valor, rotulo, provider) {
    var vistos = videoMarks[chave] || (videoMarks[chave] = {});
    if (vistos[rotulo]) return;
    vistos[rotulo] = 1;
    var prod = resolveProduct();
    var dados = {
      engagement_type: 'video',
      engagement_value: valor,
      video_seconds: valor,
      video_mark: rotulo,
      video_id: chave,
      video_provider: provider || 'smartplayer',
      product_name: prod || undefined
    };
    var payload = send('video_progress', dados);
    // Sem este espelho no dataLayer o marco fica so no nosso banco e o GA4
    // nunca sabe — e ai o publico "assistiu ate X" nasce vazio.
    pushToDataLayer('video_progress', payload, dados);
  }

  /**
   * Um tick de tempo assistido. `pitch` e o segundo em que a oferta aparece
   * (vem do proprio player); chegar la e o sinal mais forte de uma VSL —
   * separa quem ouviu o pitch e nao comprou de quem nunca chegou nele.
   */
  function tickVideo(chave, segundos, pitch, provider) {
    if (typeof segundos !== 'number' || !(segundos > 0)) return;
    for (var i = 0; i < MARCOS_SEG.length; i++) {
      if (segundos >= MARCOS_SEG[i]) {
        enviarMarcoVideo(chave, MARCOS_SEG[i], MARCOS_SEG[i] + 's', provider);
      }
    }
    if (pitch && segundos >= pitch) {
      enviarMarcoVideo(chave, Math.round(pitch), 'pitch', provider);
    }
  }

  /**
   * SmartPlayer (ConverteAI / VTurb) — o player das VSLs aqui.
   *
   * Nao e <video> nem iframe: e um web component que so fala pela propria API,
   * `smartplayer.instances[i].on('timeupdate', segundos)`. O config traz
   * `pitchTime`, o segundo em que a oferta aparece.
   *
   * Ele carrega depois da pagina, entao procuramos por um tempo curto em vez de
   * tentar uma vez so e desistir.
   */
  function hookSmartPlayer() {
    var tentativas = 0;
    var timer = setInterval(function () {
      tentativas++;
      var sp = window.smartplayer;
      var lista = sp && sp.instances;
      if (lista && lista.length) {
        for (var i = 0; i < lista.length; i++) {
          (function (inst, idx) {
            if (!inst || inst.__tsHooked || typeof inst.on !== 'function') return;
            inst.__tsHooked = 1;
            var cfg = (inst.instance && inst.instance.__config) || {};
            var chave = 'vsl-' + (cfg.id || idx);
            var pitch = Number(cfg.pitchTime) || 0;
            try {
              inst.on('timeupdate', function (seg) {
                // O player entrega o tempo direto como numero de segundos.
                var s = typeof seg === 'number' ? seg : (inst.video && inst.video.currentTime);
                tickVideo(chave, s, pitch, 'smartplayer');
              });
            } catch (e) { /* API mudou: os outros hooks seguem valendo */ }
          })(lista[i], i);
        }
        clearInterval(timer);
        return;
      }
      if (tentativas > 40) clearInterval(timer); // ~20s e o player nao veio
    }, 500);
  }

  /** <video> nativo, para paginas que nao usam SmartPlayer. */
  function hookVideosNativos() {
    var videos = document.getElementsByTagName('video');
    for (var i = 0; i < videos.length; i++) {
      (function (v, idx) {
        if (v.__tsHooked) return;
        v.__tsHooked = 1;
        v.addEventListener('timeupdate', function () {
          tickVideo('video-' + idx, v.currentTime, 0, 'html5');
        });
      })(videos[i], i);
    }
  }

  /**
   * Players em iframe falam por postMessage, cada um no seu dialeto. Procuramos
   * qualquer campo que pareca "tempo atual em segundos".
   */
  function hookPlayersEmbutidos() {
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d) return;
      try {
        if (typeof d === 'string') {
          if (d.charAt(0) !== '{') return;
          d = JSON.parse(d);
        }
      } catch (err) { return; }
      if (typeof d !== 'object') return;

      var atual = d.currentTime || d.time || d.seconds || (d.info && d.info.currentTime);
      if (typeof atual === 'number') {
        tickVideo('embed-' + (d.id || d.videoId || 'principal'), atual, 0, 'embed');
      }
    });
  }

  /**
   * Rede de seguranca: quando o player nao fala nada, medimos permanencia na
   * pagina e marcamos faixas de tempo. Nao e watch-time de verdade — e por isso
   * que vai com engagement_type "tempo_na_pagina", para nao ser confundido com
   * o dado real na hora de montar publico.
   */
  function hookTempoNaPagina() {
    var FAIXAS = [30, 60, 180, 300, 600];
    var inicio = now();
    var vistos = {};
    var timer = setInterval(function () {
      if (document.hidden) return;
      var seg = Math.round((now() - inicio) / 1000);
      for (var i = 0; i < FAIXAS.length; i++) {
        if (seg >= FAIXAS[i] && !vistos[FAIXAS[i]]) {
          vistos[FAIXAS[i]] = 1;
          var prod = resolveProduct();
          var dados = {
            engagement_type: 'tempo_na_pagina',
            engagement_value: FAIXAS[i],
            product_name: prod || undefined
          };
          var payload = send('time_on_page', dados);
          // Sem isto o marco ficava so no navegador — nao ia nem para o D1
          // (bloqueado desde o incidente de espaco) nem para o GA4. Agora vai
          // direto para o GA4 via dataLayer, sem passar pelo nosso banco.
          pushToDataLayer('time_on_page', payload, dados);
        }
      }
      if (seg >= FAIXAS[FAIXAS.length - 1]) clearInterval(timer);
    }, 5000);
  }

  function boot() {
    marcarProduto();
    hookForms();
    hookOutboundLinks();
    hookIframes();

    if (TRACK_ENGAGEMENT) {
      hookSmartPlayer();
      hookVideosNativos();
      hookPlayersEmbutidos();
      hookTempoNaPagina();
      // O player da VSL costuma entrar depois do DOM pronto.
      if (typeof MutationObserver === 'function') {
        try {
          new MutationObserver(hookVideosNativos).observe(document.documentElement, {
            childList: true,
            subtree: true
          });
        } catch (e) {}
      }
    }
  }

  hookDataLayer();
  hookWindowOpen(); // cedo: o botao da VSL pode abrir o checkout logo apos carregar
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Com page_view ligado ele ja serve de ancora; senao, mandamos o landing.
  if (TRACK_PAGE_VIEWS) {
    var prodPv = resolveProduct();
    send('page_view', prodPv ? { product_name: prodPv } : undefined);
  } else {
    sendLandingOnce();
  }
})();
