// Pretzel pack game on /free-pretzels. Talks to /api/leads?resource=packs
// (api/_packs.js). If the API is down, slow, or says the game is off,
// this script does nothing and the page stays the plain offer page.
//
// Opening sequence (timing from the reference clip; see .agent/plan.md):
//   1 Spin-in  0.0 to 0.9 s   pack spins in from edge-on, one gold glint
//   2 Charge   0.9 to 2.0 s   gold tear line draws; player swipes along it
//   3 Rip      2.0 to 2.5 s   top flies up, bottom drops, pretzel pops out
//   4 Land     2.5 to 3.3 s   pretzel overshoots and settles, rays turn
//   5 Payoff   3.3 to 6.0 s   YOU WON, FREE PRETZEL, burst, shimmer, stamp,
//                             rivets rain behind the rays
//   6 Settle   6.0 s on       rivets stop, voucher view
// Beats 3 to 6 run relative to the rip, which waits for the swipe (never
// earlier than 2.0 s). Skip jumps to beat 6. Reduced motion: one fade.
// Text is always set with textContent (never innerHTML).
//
// Game loop (plan v3): quest > pack drops in > rip > win > next quest.
// Order: free pack, Instagram, email, app, then the Golden Ticket after
// all 4. One quest card at a time; "Skip for now" keeps every code. At 3
// a player can end with "I don't need another app". Outcomes are fixed:
// every pack wins, no odds, no timers, no near-misses.
(function () {
  'use strict';

  var API = '/api/leads?resource=packs';
  var ASSETS = '/free-pretzels/packs/';
  var BEAT = { charge: 900, rip: 2000, land: 500, payoff: 1300, settle: 4000, autoRip: 8000 };
  var NY = 'America/New_York';
  var SOURCE_LABEL = { first: 'Pretzel 1: free', instagram: 'Pretzel 2: Instagram', email: 'Pretzel 3: email', app: 'Pretzel 4: app' };
  var PACKS = 5;
  var GOLDEN_SETTLE = 1500; // the Golden Ticket's rain and stamp run longer
  var UI_KEY = 'ppf_packs_ui';
  var TRAIL = {
    first: { n: '1', label: 'Free' }, instagram: { n: '2', label: 'Follow' }, email: { n: '3', label: 'Email' },
    app: { n: '4', label: 'App' }, bonus: { n: 'Golden', label: 'Ticket' }
  };
  var QUEST = {
    instagram: { step: 'Pretzel 2 of 4', title: 'Follow us on Instagram', resume: 'Get pretzel 2' },
    email: { step: 'Pretzel 3 of 4', title: 'Add your email', resume: 'Get pretzel 3' },
    app: { step: 'Pretzel 4 of 4', title: 'Get the app', resume: 'Get pretzel 4' }
  };
  var EMAIL_MSG = {
    verified: 'Email verified. Your next pack is ready.',
    expired: 'That link has expired, was already used, or was opened on a different phone. Ask for a new one below.',
    device: 'Open the link on the same phone and browser you used to ask for it.',
    already: 'This phone already has a verified email.',
    invalid: 'That link did not work. Ask for a new one below.',
    busy: 'Too many tries. Wait a few minutes and open the link again.'
  };

  var S = { state: null, picking: false, kit: null, car: null, stage3d: null, center: 2, single: false, lastNext: null };
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function reduced() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function fmtDay(iso) {
    try { return new Date(iso).toLocaleDateString('en-US', { timeZone: NY, month: 'short', day: 'numeric' }); }
    catch (e) { return ''; }
  }
  function spell(code) { return code.replace('-', '').split('').join(' '); }

  // Per-viewer UI memory (no personal data). Server state is the truth;
  // this only remembers a skipped quest so it is not shown again.
  function uiGet() {
    try { return JSON.parse(localStorage.getItem(UI_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function uiSet(patch) {
    try { localStorage.setItem(UI_KEY, JSON.stringify(Object.assign(uiGet(), patch))); } catch (e) {}
  }
  // A skip applies to one quest at one point in the game.
  function skipKey(st) { return (st.headline || '') + '|' + st.next_quest + '|' + st.used; }
  function skipped(st) { return !!st.next_quest && uiGet().skip === skipKey(st); }

  // ─── API ──────────────────────────────────────────────────────────
  function api(method, body, query, timeoutMs) {
    var ctrl = 'AbortController' in window ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs || 8000);
    var opts = { method: method, credentials: 'same-origin', cache: 'no-store', headers: {}, signal: ctrl ? ctrl.signal : undefined };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(API + (query || ''), opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        clearTimeout(timer);
        return { ok: r.ok, status: r.status, data: data || {} };
      });
    }, function (err) { clearTimeout(timer); throw err; });
  }

  // ─── pack art ─────────────────────────────────────────────────────
  function logoImg() {
    var pic = document.createElement('picture');
    var src = document.createElement('source');
    src.type = 'image/webp';
    src.srcset = ASSETS + 'ppf-logo-1864.webp';
    var img = el('img', 'pk-logo');
    img.src = ASSETS + 'ppf-logo-600.png';
    img.alt = '';
    img.draggable = false;
    img.width = 600; img.height = 555;
    img.decoding = 'async';
    pic.appendChild(src); pic.appendChild(img);
    return pic;
  }
  function buildPack(golden) {
    var pk = el('div', 'pk' + (golden ? ' golden' : ''));
    var top = el('div', 'pk-top');
    top.appendChild(el('span', 'pk-crimp'));
    var bot = el('div', 'pk-bot');
    bot.appendChild(logoImg());
    bot.appendChild(el('span', 'pk-crimp'));
    if (golden) bot.appendChild(el('span', 'pk-band', 'Golden Ticket'));
    pk.appendChild(top);
    pk.appendChild(bot);
    return pk;
  }

  // ─── page render ──────────────────────────────────────────────────
  function showGame(on) {
    document.body.classList.toggle('game-on', !!on);
    $('game').hidden = !on;
  }
  function setMsg(text) { $('game-msg').textContent = text || ''; }

  // ─── carousel ─────────────────────────────────────────────────────
  // Five slots in a native scroll-snap row. Built once; the 3D renderer
  // (pack3d.js) follows the slots' positions.
  function slots() { return Array.prototype.slice.call($('picker').querySelectorAll('.pick')); }
  function buildCarousel(preview) {
    var picker = $('picker');
    if (picker.children.length) return;
    if (!$('carousel').querySelector('.car-halo')) $('carousel').insertBefore(el('span', 'car-halo'), picker);
    for (var i = 0; i < PACKS; i++) {
      var b = el('button', 'pick');
      b.type = 'button';
      b.setAttribute('aria-label', 'Pack ' + (i + 1) + ' of ' + PACKS + '. Every pack wins a free pretzel.');
      var pk = buildPack();
      pk.appendChild(el('span', 'pk-perf'));
      b.appendChild(pk);
      if (preview) b.disabled = true;
      else b.addEventListener('click', onSlot.bind(null, i));
      picker.appendChild(b);
    }
    var raf = 0;
    picker.addEventListener('scroll', function () {
      if (raf) return;
      raf = requestAnimationFrame(function () { raf = 0; markCenter(); });
    }, { passive: true });
    // Mouse drag to swipe (touch already scrolls natively). A drag never
    // counts as a tap on a pack.
    var drag = null, dragged = false;
    picker.addEventListener('pointerdown', function (e) {
      if (S.single || e.pointerType !== 'mouse' || e.button !== 0) return;
      drag = { x: e.clientX, s: picker.scrollLeft };
      dragged = false;
    });
    window.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x;
      if (!dragged && Math.abs(dx) > 6) { dragged = true; picker.style.scrollSnapType = 'none'; }
      if (dragged) picker.scrollLeft = drag.s - dx;
    });
    function endDrag() {
      if (!drag) return;
      drag = null;
      if (!dragged) return;
      picker.style.scrollSnapType = '';
      markCenter();
      goTo(S.center);
    }
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    picker.addEventListener('dragstart', function (e) { e.preventDefault(); });
    picker.addEventListener('click', function (e) {
      if (dragged) { e.stopPropagation(); e.preventDefault(); dragged = false; }
    }, true);
    picker.addEventListener('keydown', function (e) {
      if (S.single) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); goTo(S.center + 1, true); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(S.center - 1, true); }
    });
    window.addEventListener('resize', function () { goTo(S.center, false, true); });
  }
  function markCenter() {
    var picker = $('picker');
    var mid = picker.getBoundingClientRect().left + picker.clientWidth / 2;
    var best = 0, bestD = Infinity;
    slots().forEach(function (s, i) {
      var r = s.getBoundingClientRect();
      var d = Math.abs(r.left + r.width / 2 - mid);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best !== S.center && $('car-live')) $('car-live').textContent = 'Pack ' + (best + 1) + ' of ' + PACKS;
    S.center = best;
    slots().forEach(function (s, i) {
      s.classList.toggle('is-center', i === best);
      if (i === best) s.setAttribute('aria-current', 'true'); else s.removeAttribute('aria-current');
    });
  }
  function goTo(i, focus, instant) {
    i = Math.max(0, Math.min(PACKS - 1, i));
    var s = slots()[i];
    if (!s) return;
    var picker = $('picker');
    var left = s.offsetLeft + s.offsetWidth / 2 - picker.clientWidth / 2;
    picker.scrollTo({ left: left, behavior: instant || reduced() ? 'auto' : 'smooth' });
    if (focus) s.focus({ preventScroll: true });
    if (instant) markCenter();
  }
  // Tap a side pack: bring it to the centre. Tap the centre pack: open it.
  function onSlot(i) {
    if (i === S.center) onPick(i);
    else if (!S.single) goTo(i);
  }

  function renderPicker(st, preview) {
    var canOpen = preview || (st && st.can_open);
    buildCarousel(preview);
    var used = (st && st.used) || 0;
    var golden = !!(st && st.next_source === 'bonus');
    // First pull: pick 1 of 5. After that: one pack at a time.
    var single = !preview && canOpen && used > 0;
    var dropIn = single && S.lastNext !== (st && st.next_source);
    S.lastNext = st ? st.next_source : null;
    S.single = single;
    $('carousel').hidden = !canOpen;
    $('carousel').classList.toggle('single', single);
    $('g-hint').hidden = !canOpen;
    $('g-hint').textContent = single ? 'Tap the pack to open' : 'Swipe to select & tap pack to open';
    $('picker').classList.remove('leaving');
    slots().forEach(function (s, i) {
      var pk = s.querySelector('.pk');
      if (pk) pk.classList.toggle('golden', golden && i === S.center);
      var band = s.querySelector('.pk-band');
      if (golden && i === S.center && !band) pk.querySelector('.pk-bot').appendChild(el('span', 'pk-band', 'Golden Ticket'));
      if (band && !(golden && i === S.center)) band.remove();
      s.setAttribute('aria-label', single
        ? (golden ? 'Your Golden Ticket pack. Tap to open.' : 'Pretzel ' + (used + 1) + ' of 4. Tap to open.')
        : 'Pack ' + (i + 1) + ' of ' + PACKS + '. Every pack wins a free pretzel.');
    });
    var title, sub;
    if (!st || used === 0) { title = 'Pick a pack'; sub = 'Pull a pretzel and WIN a pretzel!'; }
    else if (golden) { title = 'Golden Ticket pack'; sub = 'You collected all 4. Tap it to open.'; }
    else if (canOpen) { title = 'Pretzel ' + (used + 1) + ' of 4'; sub = 'Your next pack is here. Tap it to open.'; }
    else if (st.ended === 'stopped_at_3') { title = 'Thanks for playing'; sub = 'Show a code at the counter.'; }
    else if (st.ended === 'completed') { title = 'Set complete'; sub = 'Show a code at the counter.'; }
    else if (st.next_quest && !skipped(st)) { title = 'Keep going'; sub = 'One quick step for your next pretzel.'; }
    else { title = used > 1 ? 'Your free pretzels' : 'Your free pretzel'; sub = 'Show a code at the counter.'; }
    $('game-title').textContent = title;
    $('game-sub').textContent = sub;
    slots().forEach(function (s, i) {
      if (s.getAnimations) s.getAnimations().forEach(function (a) { a.cancel(); });
      // In single mode the centre pack is the only one; mark it now, not
      // only after the next frame's scroll measurement.
      if (single) {
        s.classList.toggle('is-center', i === S.center);
        if (i === S.center) s.setAttribute('aria-current', 'true'); else s.removeAttribute('aria-current');
      }
    });
    if (canOpen) {
      // Snap to the centre pack now (layout is ready once unhidden), so the
      // 3D packs and the tap targets agree even before the next frame.
      goTo(S.center, false, true);
      requestAnimationFrame(function () {
        goTo(S.center, false, true);
        if (S.car) {
          S.car.reset();
          S.car.setSingle(single ? S.center : -1, golden);
          if (dropIn && !reduced()) S.car.drop(700);
        } else if (dropIn && !reduced()) {
          var c = slots()[S.center];
          if (c) c.animate([{ transform: 'translateY(-70vh)' }, { transform: 'translateY(0)' }], { duration: 700, easing: 'cubic-bezier(.2,.8,.3,1.15)' });
        }
        if (dropIn && !reduced()) {
          var halo = $('carousel').querySelector('.car-halo');
          if (halo && halo.animate) halo.animate([{ opacity: 0, transform: 'scale(0.4)' }, { opacity: 0.35, transform: 'scale(1)', offset: 0.6 }, { opacity: 0, transform: 'scale(1.2)' }], { duration: 900, delay: 450, easing: 'ease-out' });
        }
      });
    } else if (S.car) {
      S.car.pause();
    }
  }

  // 3D packs. Optional: any failure keeps the CSS packs.
  function init3D() {
    if (reduced() || S.kit || S.kitLoading) return;
    S.kitLoading = true;
    import('/free-pretzels/pack3d.js').then(function (m) {
      if (!m.webglOK()) return null;
      return m.createKit({ assets: ASSETS });
    }).then(function (kit) {
      if (!kit) return;
      // Build both first, so a failure leaves no half-3D state.
      var car = kit.carousel($('car-gl'), $('picker'), slots());
      var stage = kit.stage($('st-gl'), stageAnchor);
      car.onLost = stage.onLost = drop3D;
      S.kit = kit; S.car = car; S.stage3d = stage;
      $('carousel').classList.add('gl');
    }).catch(function () { drop3D(); });
  }
  // Back to the CSS packs (load failure or a lost WebGL context).
  function drop3D() {
    $('carousel').classList.remove('gl');
    var st = $('stage');
    if (st) st.classList.remove('gl');
    S.car = null; S.stage3d = null;
  }
  // Where the stage's DOM pack box sits (unaffected by its spin transform).
  function stageAnchor() {
    var pk = document.querySelector('#stage .st-pack .pk');
    var c = document.querySelector('#stage .st-center');
    if (!pk || !c) return null;
    var r = c.getBoundingClientRect();
    return { left: r.left - pk.offsetWidth / 2, top: r.top - pk.offsetHeight / 2, width: pk.offsetWidth, height: pk.offsetHeight };
  }

  function voucherLabel(v) { return v.source === 'bonus' ? (v.title || 'Golden Ticket') : (SOURCE_LABEL[v.source] || 'Free pretzel'); }

  // The set: newest first. Tap a card to open it; the newest live code
  // starts open so it is ready for the counter.
  function renderVouchers(st) {
    var box = $('vouchers');
    box.textContent = '';
    var list = (st.vouchers || []).slice().reverse();
    var openIdx = list.findIndex ? list.findIndex(function (v) { return !v.redeemed_at && !v.expired; }) : 0;
    list.forEach(function (v, i) {
      var done = !!v.redeemed_at || v.expired;
      var card = el('div', 'vcard' + (done ? ' done' : '') + (v.source === 'bonus' ? ' ticket' : ''));
      var head = el('button', 'vc-head');
      head.type = 'button';
      head.appendChild(el('span', 'vc-label', voucherLabel(v)));
      head.appendChild(el('span', 'vc-code', v.code));
      var body = el('div', 'vc-body');
      body.id = 'vc-' + v.code;
      head.setAttribute('aria-controls', body.id);
      if (v.source === 'bonus') body.appendChild(el('p', 'vc-text', v.text || ''));
      var stub = el('div', v.source === 'bonus' ? 'vc-stub' : '');
      stub.appendChild(el('p', 'vc-big', v.code));
      var meta;
      if (v.redeemed_at) meta = 'Redeemed' + (v.redeemed_store ? ' at ' + v.redeemed_store : '') + ', ' + fmtDay(v.redeemed_at) + '.';
      else if (v.expired) meta = 'Expired ' + fmtDay(v.expires_at) + '.';
      else meta = 'Good through ' + fmtDay(v.expires_at) + '. Show this at the counter.';
      stub.appendChild(el('p', 'vc-meta', meta));
      if (!done) {
        var b = el('button', 'btn btn-green', 'Staff: redeem');
        b.type = 'button';
        b.addEventListener('click', function () { openRedeem(v.code, b); });
        stub.appendChild(b);
      }
      body.appendChild(stub);
      function setOpen(on) {
        card.classList.toggle('open', on);
        body.hidden = !on;
        head.setAttribute('aria-expanded', on ? 'true' : 'false');
      }
      setOpen(i === openIdx);
      head.addEventListener('click', function () { setOpen(body.hidden); });
      card.appendChild(head);
      card.appendChild(body);
      box.appendChild(card);
    });
    $('set').hidden = !list.length;
    $('set-head').textContent = list.length > 1 ? 'Your codes' : 'Your code';
  }

  function renderTrail(st) {
    var box = $('trail');
    box.hidden = !(st.used > 0);
    if (box.hidden) return;
    var row = $('trail-row');
    row.textContent = '';
    (st.trail || []).forEach(function (node) {
      var t = TRAIL[node.key];
      var li = el('li', node.key + ' ' + node.state + (node.key === st.next_quest ? ' current' : ''));
      li.appendChild(el('span', 'tn-dot', t.n));
      var lbl = node.state === 'done' ? (node.key === 'bonus' ? 'Ticket' : 'Got it') : t.label;
      li.appendChild(el('span', 'tn-lbl', lbl));
      var words = { done: 'collected', ready: 'ready to open', locked: 'not yet', off: 'off' };
      li.setAttribute('aria-label', (node.key === 'bonus' ? 'Golden Ticket' : 'Pretzel ' + t.n) + ': ' + words[node.state]);
      row.appendChild(li);
    });
    $('trail-count').textContent = st.used + ' of 4 collected';
  }

  // One quest card, or nothing. Never a list.
  function renderQuest(st) {
    var q = st.next_quest;
    var show = !!q && !st.can_open && !st.ended && !skipped(st);
    $('quest').hidden = !show;
    $('q-resume').hidden = !(q && !st.can_open && !st.ended && skipped(st));
    if (q && QUEST[q]) $('q-resume').textContent = QUEST[q].resume;
    if (!show) { S.lastQuest = null; return; }
    // A new quest slides in (after a win, or on resume).
    if (S.lastQuest !== q && !reduced() && $('quest').animate) {
      $('quest').animate([{ opacity: 0, transform: 'translateY(28px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 420, easing: 'cubic-bezier(.2,.8,.3,1)' });
    }
    S.lastQuest = q;
    $('q-step').textContent = QUEST[q].step;
    $('q-title').textContent = QUEST[q].title;
    $('q-ig').hidden = q !== 'instagram';
    $('q-email').hidden = q !== 'email';
    $('q-app').hidden = q !== 'app';
    $('q-skip').hidden = q === 'app';
    $('ig-handle').textContent = st.instagram ? '@' + st.instagram : '';
    $('q-gold').hidden = !(st.bonus && st.bonus.on);
    $('stop-btn').hidden = !st.can_stop;
    if (!st.can_stop) $('stop-confirm').hidden = true;
  }

  function renderEnd(st) {
    var end = $('g-end');
    var hasTicket = (st.vouchers || []).some(function (v) { return v.source === 'bonus'; });
    if (st.ended === 'stopped_at_3') {
      end.hidden = false;
      $('g-end-title').textContent = 'Thanks for playing.';
      $('g-end-body').textContent = 'You keep your 3 pretzels. Show a code at the counter.';
    } else if (st.ended === 'completed' && !st.can_open) {
      end.hidden = false;
      $('g-end-title').textContent = hasTicket ? 'Set complete. 4 of 4 and a Golden Ticket.' : 'Set complete. 4 of 4.';
      $('g-end-body').textContent = 'Thanks for playing. Show a code at the counter.';
    } else {
      end.hidden = true;
    }
    // The end message is the heading; no second title above it.
    $('game-title').hidden = $('game-sub').hidden = !end.hidden;
  }

  function render(st) {
    S.state = st;
    renderTrail(st);
    renderPicker(st);
    renderQuest(st);
    renderEnd(st);
    renderVouchers(st);
  }

  function refresh() {
    return api('GET', null, '&view=state', 4000).then(function (r) {
      if (r.ok && r.data && r.data.game) render(r.data);
      return r;
    }).catch(function () {});
  }

  // ─── picking + opening ────────────────────────────────────────────
  function onPick(i) {
    if (S.picking) return;
    S.picking = true;
    setMsg('');
    var picker = $('picker');
    picker.classList.add('leaving');
    var picks = slots();
    var started = performance.now();
    if (S.car) {
      // Beat 0 (3D): the chosen pack rises, the others drop away, then
      // the carousel stops drawing while the stage runs.
      var car = S.car;
      car.choose(i, 380).then(function () { car.pause(); });
    } else if (!reduced()) {
      // Beat 0: the others leave the screen.
      picks.forEach(function (p, n) {
        if (n === i) return;
        p.animate([{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(60vh)', opacity: 0 }],
          { duration: 380, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' });
      });
    }
    var opening = api('POST', { action: 'open' });
    opening.then(function (r) {
      var wait = Math.max(0, (reduced() ? 0 : 400) - (performance.now() - started));
      setTimeout(function () {
        S.picking = false;
        if (!r.ok || !r.data.voucher) {
          if (r.data && r.data.state && r.data.state.game) render(r.data.state);
          else renderPicker(S.state);
          setMsg((r.data && r.data.error) || 'We could not open your pack. Show this page at the counter and ask for your free pretzel.');
          return;
        }
        S.state = r.data.state;
        Stage.play(r.data.voucher, function () { render(S.state); }, r.data.state.used);
      }, wait);
    }, function () {
      S.picking = false;
      renderPicker(S.state);
      setMsg('We could not reach the pack game. Check your signal and try again, or show this page at the counter.');
    });
  }

  // ─── canvas FX: shards, sparkles, falling rivets ─────────────────
  var FX = (function () {
    // Back canvas (behind the rays): falling rivets, so they never cover
    // the pretzel or the code. Front canvas (above the pretzel): the gold
    // shard burst and sparkles.
    var cv, ctx, cv2, ctx2, w = 0, h = 0, dpr = 1, raf = 0, last = 0;
    var rivets = [], shards = [], sparks = [];
    var spawnRivets = false, sparkleOn = false, spawnAcc = 0, maxRivets = 40, dtAvg = 16;
    var imgs = [];
    var NAMES = ['rivet-plain', 'rivet-salted-short', 'rivet-salted-long', 'rivet-pair'];
    var GOLDS = ['#D4B662', '#B2872F', '#F2E7A4'];

    function load() {
      if (imgs.length) return;
      NAMES.forEach(function (n) {
        var img = new Image();
        img.decoding = 'async';
        img.onerror = function () { if (img.src.indexOf('.webp') > 0) img.src = ASSETS + n + '.png'; };
        img.src = ASSETS + n + '.webp';
        imgs.push(img);
      });
      try {
        if (navigator.getBattery) navigator.getBattery().then(function (b) { if (!b.charging && b.level < 0.2) { cap = 20; maxRivets = 20; } });
      } catch (e) {}
    }
    function size() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = cv.clientWidth; h = cv.clientHeight;
      [cv, cv2].forEach(function (c) {
        c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
        c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
      });
    }
    function attach(back, front) {
      cv = back; ctx = cv.getContext('2d');
      cv2 = front; ctx2 = cv2.getContext('2d');
      size();
    }
    function rand(a, b) { return a + Math.random() * (b - a); }
    function addRivet(y) {
      var ready = imgs.filter(function (i) { return i.complete && i.naturalWidth; });
      if (!ready.length) return;
      var img = ready[Math.floor(Math.random() * ready.length)];
      var long = rand(40, 70);
      var s = long / Math.max(img.naturalWidth, img.naturalHeight);
      rivets.push({ img: img, x: rand(0, w), y: y == null ? -60 : y, w: img.naturalWidth * s, h: img.naturalHeight * s,
        vy: h / rand(1.9, 3.2), rot: rand(0, 6.28), vr: rand(-1.6, 1.6) });
    }
    function burst(cx, cy) {
      for (var i = 0; i < 34; i++) {
        var a = rand(0, Math.PI * 2), sp = rand(260, 720);
        shards.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 120, rot: rand(0, 6.28), vr: rand(-9, 9),
          s: rand(6, 15), c: GOLDS[i % 3], life: 0, max: rand(0.9, 1.4) });
      }
      start();
    }
    function sparkle(box) {
      sparkleOn = !!box;
      sparkle.box = box;
      if (box) start();
    }
    function rain(on) { spawnRivets = on; if (on) start(); }
    // Each win a little bigger: more rivets per pack number. The Golden
    // Ticket is the biggest. Low battery or a slow phone still caps it.
    var cap = 60;
    function level(n) { maxRivets = Math.min(cap, 24 + 6 * Math.max(1, n)); }
    function star(x, y, r, a) {
      var c = ctx2;
      c.globalAlpha = a;
      c.fillStyle = '#F2E7A4';
      c.beginPath();
      c.moveTo(x, y - r); c.lineTo(x + r * 0.28, y - r * 0.28); c.lineTo(x + r, y);
      c.lineTo(x + r * 0.28, y + r * 0.28); c.lineTo(x, y + r); c.lineTo(x - r * 0.28, y + r * 0.28);
      c.lineTo(x - r, y); c.lineTo(x - r * 0.28, y - r * 0.28);
      c.closePath(); c.fill();
    }
    function frame(t) {
      var dt = Math.min(0.05, (t - (last || t)) / 1000);
      last = t;
      dtAvg = dtAvg * 0.9 + dt * 1000 * 0.1;
      if (dtAvg > 28 && maxRivets > 20) { cap = 20; maxRivets = 20; } // low frame rate: fewer rivets
      ctx.clearRect(0, 0, w, h);
      ctx2.clearRect(0, 0, w, h);
      if (spawnRivets) {
        spawnAcc += dt * maxRivets / 2.4;
        while (spawnAcc >= 1) { spawnAcc -= 1; if (rivets.length < maxRivets) addRivet(); }
      }
      for (var i = rivets.length - 1; i >= 0; i--) {
        var r = rivets[i];
        r.y += r.vy * dt; r.rot += r.vr * dt;
        if (r.y - r.h > h) { rivets.splice(i, 1); continue; }
        ctx.save(); ctx.globalAlpha = 1; ctx.translate(r.x, r.y); ctx.rotate(r.rot);
        ctx.drawImage(r.img, -r.w / 2, -r.h / 2, r.w, r.h);
        ctx.restore();
      }
      if (sparkleOn && sparkle.box && Math.random() < 0.6) {
        var b = sparkle.box;
        sparks.push({ x: rand(b.left - 30, b.right + 30), y: rand(b.top, b.bottom), life: 0, max: rand(0.5, 0.9), r: rand(5, 11) });
      }
      for (var k = sparks.length - 1; k >= 0; k--) {
        var p = sparks[k];
        p.life += dt;
        if (p.life >= p.max) { sparks.splice(k, 1); continue; }
        var q = p.life / p.max;
        star(p.x, p.y, p.r * (q < 0.5 ? q * 2 : (1 - q) * 2), 1);
      }
      for (var j = shards.length - 1; j >= 0; j--) {
        var s = shards[j];
        s.life += dt;
        if (s.life >= s.max) { shards.splice(j, 1); continue; }
        s.vy += 900 * dt; s.vx *= 0.985;
        s.x += s.vx * dt; s.y += s.vy * dt; s.rot += s.vr * dt;
        ctx2.save(); ctx2.globalAlpha = 1 - s.life / s.max; ctx2.fillStyle = s.c;
        ctx2.translate(s.x, s.y); ctx2.rotate(s.rot);
        ctx2.beginPath(); ctx2.moveTo(0, -s.s); ctx2.lineTo(s.s * 0.6, s.s * 0.7); ctx2.lineTo(-s.s * 0.6, s.s * 0.5); ctx2.closePath(); ctx2.fill();
        ctx2.restore();
      }
      ctx.globalAlpha = 1; ctx2.globalAlpha = 1;
      if (spawnRivets || sparkleOn || rivets.length || shards.length || sparks.length) raf = requestAnimationFrame(frame);
      else { raf = 0; last = 0; ctx.clearRect(0, 0, w, h); ctx2.clearRect(0, 0, w, h); }
    }
    function start() { if (!raf && ctx) { last = 0; raf = requestAnimationFrame(frame); } }
    function stop() {
      spawnRivets = false; sparkleOn = false;
      rivets = []; shards = []; sparks = [];
      if (raf) cancelAnimationFrame(raf);
      raf = 0; last = 0;
      if (ctx) { ctx.clearRect(0, 0, w, h); ctx2.clearRect(0, 0, w, h); }
    }
    return { load: load, attach: attach, size: size, burst: burst, sparkle: sparkle, rain: rain, stop: stop, level: level,
      running: function () { return !!raf; }, count: function () { return rivets.length; } };
  })();

  // ─── stage: the six beats ─────────────────────────────────────────
  var Stage = (function () {
    var gl = null;
    var root, nodes = {}, timers = [], voucher = null, onDone = null, t0 = 0, ripAt = 0, torn = false, phase = '', opener = null;
    var golden = false, packNo = 1;
    var T = { marks: {} };
    window.__ppfPackTimeline = T;

    function build() {
      root = $('stage');
      nodes.canvas = root.querySelector('.st-canvas');
      nodes.front = root.querySelector('.st-canvas-front');
      nodes.rays = root.querySelector('.st-rays');
      nodes.center = root.querySelector('.st-center');
      nodes.prize = root.querySelector('.st-prize');
      nodes.band = root.querySelector('.st-shine i');
      nodes.won = root.querySelector('.st-won');
      nodes.what = root.querySelector('.st-what');
      nodes.stamp = root.querySelector('.st-stamp');
      nodes.hint = root.querySelector('.st-hint');
      nodes.skip = root.querySelector('.st-skip');
      nodes.card = root.querySelector('.st-voucher');
      nodes.live = $('st-live');
      nodes.skip.addEventListener('click', skip);
      $('sv-done').addEventListener('click', close);
      $('sv-redeem').addEventListener('click', function () { if (voucher) openRedeem(voucher.code, $('sv-redeem')); });
      root.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); if (phase === 'settled') close(); else skip(); }
        if (e.key === 'Tab') trapTab(e, root);
      });
      window.addEventListener('resize', function () { if (!root.hidden) FX.size(); });
    }

    function at(ms, fn) { timers.push(setTimeout(fn, Math.max(0, ms - (performance.now() - t0)))); }
    function mark(name) { T.marks[name] = Math.round(performance.now() - t0); }
    function anim(node, frames, opts) {
      if (!node || !node.animate) return null;
      return node.animate(frames, Object.assign({ fill: 'forwards', easing: 'ease-out' }, opts));
    }
    function announce(text) { nodes.live.textContent = text; }

    function freshPack() {
      nodes.center.textContent = '';
      var wrap = el('div', 'st-pack');
      var pk = buildPack(golden);
      var clip = el('div', 'st-glint-clip');
      clip.appendChild(el('span', 'st-glint'));
      pk.appendChild(clip);
      pk.appendChild(el('span', 'st-tear'));
      var hit = el('button', 'st-hit');
      hit.type = 'button';
      hit.setAttribute('aria-label', 'Tear open the pack');
      pk.appendChild(hit);
      wrap.appendChild(pk);
      nodes.center.appendChild(wrap);
      nodes.pack = wrap;
      nodes.top = pk.querySelector('.pk-top');
      nodes.bot = pk.querySelector('.pk-bot');
      nodes.logo = pk.querySelector('.pk-logo');
      nodes.glint = pk.querySelector('.st-glint');
      nodes.tear = pk.querySelector('.st-tear');
      nodes.hit = hit;
      wireSwipe(hit);
    }

    function wireSwipe(hit) {
      var sx = null, sy = 0, moved = 0;
      hit.addEventListener('pointerdown', function (e) {
        sx = e.clientX; sy = e.clientY; moved = 0;
        try { hit.setPointerCapture(e.pointerId); } catch (err) {}
      });
      hit.addEventListener('pointermove', function (e) {
        if (sx == null) return;
        moved = Math.max(moved, Math.abs(e.clientX - sx));
        if (moved > Math.min(90, hit.clientWidth * 0.35) && Math.abs(e.clientY - sy) < hit.clientHeight * 0.4) { sx = null; tear(); }
      });
      hit.addEventListener('pointerup', function () { sx = null; });
      // Tap, Enter and Space all arrive as a click.
      hit.addEventListener('click', tear);
    }

    function reset() {
      timers.forEach(clearTimeout); timers = [];
      FX.stop();
      if (gl) gl.hide();
      gl = null;
      root.classList.remove('gl');
      root.getAnimations && root.getAnimations({ subtree: true }).forEach(function (a) { a.cancel(); });
      root.classList.remove('settled', 'error', 'golden');
      nodes.rays.classList.remove('turning');
      nodes.hint.classList.remove('wait');
      nodes.card.hidden = true;
      torn = false; ripAt = 0; phase = '';
      T.marks = {};
      announce('');
    }

    function play(v, done, n) {
      voucher = v; onDone = done; opener = document.activeElement;
      golden = v.source === 'bonus';
      packNo = golden ? 5 : Math.max(1, Math.min(4, n || 1));
      if (!root) build();
      reset();
      root.classList.toggle('golden', golden);
      root.setAttribute('aria-label', golden ? 'Opening your Golden Ticket' : 'Opening your pack');
      nodes.what.textContent = golden ? (v.title || 'Golden Ticket') : 'Free pretzel';
      nodes.stamp.textContent = golden ? 'BONUS' : (packNo === 4 ? '4 OF 4' : 'FREE');
      nodes.stamp.classList.toggle('small', golden || packNo === 4);
      FX.level(golden ? 10 : packNo);
      fillCard(v);
      freshPack();
      root.hidden = false;
      document.documentElement.classList.add('stage-open');
      FX.attach(nodes.canvas, nodes.front);
      FX.load();
      t0 = performance.now();
      T.t0 = t0;
      T.reduced = reduced();
      if (T.reduced) return playReduced();
      nodes.skip.focus({ preventScroll: true });
      gl = S.stage3d || null;
      root.classList.toggle('gl', !!gl);
      if (gl) { gl.reset(golden ? 'golden' : 'satin'); gl.spinIn(900); }

      // Beat 1: spin-in with one gold glint. Logo hidden while turning.
      phase = 'spin'; mark('spin');
      anim(nodes.pack, [{ transform: 'rotateY(90deg)' }, { transform: 'rotateY(0deg)' }], { duration: 900, easing: 'cubic-bezier(.2,.7,.2,1)' });
      anim(nodes.glint, [{ opacity: 0.55, transform: 'translateX(-160%) skewX(-18deg)' }, { opacity: 0.55, transform: 'translateX(420%) skewX(-18deg)' }], { duration: 520, delay: 380, easing: 'ease-in-out' });

      // Beat 2: charge. Logo fades in flat and upright, line draws.
      at(BEAT.charge, function () {
        phase = 'charge'; mark('charge');
        anim(nodes.logo, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
        anim(nodes.pack, [{ transform: 'scale(1)' }, { transform: 'scale(1.025)' }, { transform: 'scale(1)' }], { duration: 1100, easing: 'ease-in-out', fill: 'none' });
        anim(nodes.tear, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 600, easing: 'cubic-bezier(.3,.6,.3,1)' });
        anim(nodes.hint, [{ opacity: 0 }, { opacity: 1 }], { duration: 250, delay: 400 });
        nodes.hint.textContent = 'Swipe to rip the pack!';
        nodes.hit.focus({ preventScroll: true });
        if (gl) { gl.showLogo(200); gl.breathe(1100); gl.drawTear(600); }
      });
      at(BEAT.charge + 600, function () { nodes.tear.classList.add('bright'); if (gl) gl.brighten(400); });
      at(BEAT.rip, function () {
        if (torn) return;
        nodes.hint.classList.add('wait');
        mark('waiting');
      });
      at(BEAT.autoRip, function () { tear(); }); // never stall
    }

    function tear() {
      if (torn || !root || root.hidden || (phase !== 'spin' && phase !== 'charge')) return;
      torn = true;
      var now = performance.now() - t0;
      ripAt = Math.max(BEAT.rip, now);
      mark('torn');
      at(ripAt, rip);
    }

    // Beat 3: rip. Top flies up, bottom (with the logo) drops straight down.
    function rip() {
      phase = 'rip'; mark('rip');
      nodes.hint.classList.remove('wait');
      anim(nodes.hint, [{ opacity: 1 }, { opacity: 0 }], { duration: 120 });
      anim(nodes.tear, [{ opacity: 1 }, { opacity: 0 }], { duration: 120 });
      anim(nodes.top, [{ transform: 'translateY(0) rotate(0)' }, { transform: 'translateY(-120vh) rotate(-14deg)' }], { duration: 500, easing: 'cubic-bezier(.4,0,.9,.6)' });
      anim(nodes.bot, [{ transform: 'translateY(0)' }, { transform: 'translateY(120vh)' }], { duration: 500, easing: 'cubic-bezier(.5,0,1,.5)' });
      if (gl) gl.rip(500);
      anim(nodes.prize, [
        { opacity: 0, transform: 'translate(-50%, -30%) scale(0.45)' },
        { opacity: 1, transform: 'translate(-50%, -58%) scale(1.06)' }
      ], { duration: 500, easing: 'cubic-bezier(.2,.9,.3,1.2)' });
      anim(nodes.rays, [{ opacity: 0, transform: 'scale(0.2)' }, { opacity: 0.32, transform: 'scale(1)' }], { duration: 500 });
      nodes.rays.classList.add('turning');
      nodes.hit.disabled = true;
      nodes.skip.focus({ preventScroll: true });
      at(ripAt + BEAT.land, land);
      at(ripAt + BEAT.payoff, payoff);
      at(ripAt + BEAT.settle + (golden ? GOLDEN_SETTLE : 0), settle);
    }

    // Beat 4: land. Overshoot, then settle at centre. Sparkles start.
    function land() {
      phase = 'land'; mark('land');
      anim(nodes.prize, [
        { opacity: 1, transform: 'translate(-50%, -58%) scale(1.06)' },
        { opacity: 1, transform: 'translate(-50%, -47%) scale(0.98)', offset: 0.55 },
        { opacity: 1, transform: 'translate(-50%, -50%) scale(1)' }
      ], { duration: 800, easing: 'ease-out' });
      FX.sparkle(nodes.prize.getBoundingClientRect());
    }

    // Beat 5: golden win.
    function payoff() {
      phase = 'payoff'; mark('payoff');
      var slam = [{ opacity: 0, transform: 'scale(2.4)' }, { opacity: 1, transform: 'scale(0.96)', offset: 0.7 }, { opacity: 1, transform: 'scale(1)' }];
      anim(nodes.won, slam, { duration: 280, easing: 'ease-in' });
      anim(nodes.what, slam, { duration: 280, delay: 300, easing: 'ease-in' });
      var b = nodes.prize.getBoundingClientRect();
      FX.burst(b.left + b.width / 2, b.top + b.height / 2);
      FX.rain(true);
      anim(nodes.band, [{ opacity: 0.6, transform: 'translateX(-150%) skewX(-16deg)' }, { opacity: 0.6, transform: 'translateX(330%) skewX(-16deg)' }], { duration: 700 + 100 * packNo, delay: 400, easing: 'ease-in-out' });
      anim(nodes.stamp, [{ opacity: 0, transform: 'scale(2.2) rotate(-20deg)' }, { opacity: 1, transform: 'scale(1) rotate(-12deg)' }], { duration: 220, delay: 700, easing: 'ease-in' });
      announce(golden ? 'You won the Golden Ticket.' : 'You won a free pretzel.');
    }

    // Beat 6: settle. No loop. Rivets stop spawning and fall away.
    function settle(fromSkip) {
      if (phase === 'settled') return;
      phase = 'settled'; mark('settle');
      timers.forEach(clearTimeout); timers = [];
      if (gl) gl.hide();
      FX.rain(false);
      FX.sparkle(null);
      if (fromSkip === true) FX.stop();
      nodes.card.hidden = false;
      if (fromSkip === true || T.reduced) {
        root.getAnimations && root.getAnimations({ subtree: true }).forEach(function (a) { a.cancel(); });
        root.classList.add('settled');
        if (T.reduced) anim(root, [{ opacity: 0 }, { opacity: 1 }], { duration: 300, fill: 'none' });
      } else {
        var cs = getComputedStyle(nodes.prize);
        anim(nodes.prize, [
          { top: cs.top, opacity: 1, transform: 'translate(-50%, -50%) scale(1)' },
          { top: '20%', opacity: 1, transform: 'translate(-50%, -50%) scale(0.4)' }
        ], { duration: 600, easing: 'cubic-bezier(.3,.7,.2,1)' });
        anim(nodes.card, [{ opacity: 0, transform: 'translate(-50%, 24px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 400, delay: 300 });
        [nodes.won, nodes.what, nodes.stamp].forEach(function (n) { anim(n, [{ opacity: 1 }, { opacity: 0 }], { duration: 250 }); });
        anim(nodes.rays, [{ opacity: 0.32 }, { opacity: 0.12 }], { duration: 600 });
        timers.push(setTimeout(function () {
          root.getAnimations({ subtree: true }).forEach(function (a) { if (a.effect && a.effect.target !== nodes.rays.firstElementChild) a.cancel(); });
          root.classList.add('settled');
        }, 760));
      }
      announce((golden ? 'You won the Golden Ticket. ' + (voucher.text || '') : 'You won a free pretzel.') +
        ' Your code is ' + spell(voucher.code) + '. Show this at the counter.');
      $('sv-done').focus({ preventScroll: true });
    }

    function playReduced() {
      // One crossfade straight to the gold card. No spin, rip or burst.
      phase = 'spin'; mark('spin');
      settle();
    }

    function skip() { if (phase && phase !== 'settled') settle(true); }

    function fillCard(v) {
      var g = v.source === 'bonus';
      $('sv-label').textContent = g ? (v.title || 'Golden Ticket') : 'Your free pretzel';
      $('sv-code').textContent = v.code;
      $('sv-exp').textContent = 'Good through ' + fmtDay(v.expires_at) + '.';
      $('sv-how').textContent = g ? (v.text || 'Show this at the counter.') : 'Show this at the counter.';
    }

    function close() {
      reset();
      root.hidden = true;
      document.documentElement.classList.remove('stage-open');
      if (onDone) onDone();
      var t = $('game-title').hidden ? $('g-end-title') : $('game-title');
      t.setAttribute('tabindex', '-1');
      t.focus({ preventScroll: false });
      opener = null;
    }

    return { play: play, skip: skip, close: close, timeline: T };
  })();

  function trapTab(e, scope) {
    var f = Array.prototype.filter.call(scope.querySelectorAll('button, input, a[href]'), function (n) {
      return !n.disabled && n.offsetParent !== null;
    });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // ─── staff redeem sheet ───────────────────────────────────────────
  var redeemOpener = null;
  function openRedeem(code, opener) {
    redeemOpener = opener || null;
    var sh = $('redeem');
    $('rd-code').textContent = code;
    $('rd-pin').value = '';
    $('rd-msg').textContent = '';
    $('rd-form').hidden = false;
    $('rd-ok').hidden = true;
    $('rd-badge').hidden = true;
    $('rd-give').hidden = true;
    $('rd-give').textContent = '';
    sh.hidden = false;
    document.documentElement.classList.add('stage-open');
    $('rd-pin').focus();
  }
  function closeRedeem() {
    $('redeem').hidden = true;
    if ($('stage').hidden) document.documentElement.classList.remove('stage-open');
    if (redeemOpener && redeemOpener.focus) redeemOpener.focus();
  }
  function initRedeem() {
    var sh = $('redeem');
    $('rd-cancel').addEventListener('click', closeRedeem);
    $('rd-close').addEventListener('click', function () {
      closeRedeem();
      if (!$('stage').hidden) Stage.close();
    });
    sh.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeRedeem(); }
      if (e.key === 'Tab') trapTab(e, sh);
    });
    $('rd-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var storeEl = sh.querySelector('input[name="rd-store"]:checked');
      var msg = $('rd-msg');
      if (!storeEl) { msg.textContent = 'Pick the store first.'; return; }
      var pin = $('rd-pin').value.trim();
      if (!/^\d{4}$/.test(pin)) { msg.textContent = 'The PIN is 4 digits.'; return; }
      var btn = $('rd-submit');
      btn.disabled = true;
      msg.textContent = 'Checking...';
      api('POST', { action: 'redeem', code: $('rd-code').textContent, pin: pin, store: storeEl.value }).then(function (r) {
        btn.disabled = false;
        $('rd-pin').value = '';
        if (!r.ok) {
          msg.textContent = (r.data && r.data.error ? r.data.error : 'Not redeemed.') +
            (r.data && r.data.tries_left != null ? ' ' + r.data.tries_left + ' tries left for this code.' : '');
          return;
        }
        $('rd-form').hidden = true;
        $('rd-ok').hidden = false;
        var staff = r.data.staff || {};
        var isTicket = r.data.voucher.source === 'bonus';
        $('rd-ok-text').textContent = 'Redeemed at ' + (r.data.voucher.redeemed_store || 'the store') + '.' + (isTicket ? '' : ' Enjoy your pretzel.');
        $('rd-badge').hidden = !staff.completed_all;
        $('rd-give').hidden = !isTicket;
        $('rd-give').textContent = isTicket ? 'Give: ' + (staff.give || 'ask a manager') : '';
        $('rd-close').focus();
        refresh();
      }, function () {
        btn.disabled = false;
        msg.textContent = 'No connection. Write the code down and honour it.';
      });
    });
  }

  // ─── bonus packs ──────────────────────────────────────────────────
  function initBonus() {
    $('email-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var st = $('email-status');
      var email = $('email-input').value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { st.textContent = 'That email does not look right.'; return; }
      var btn = $('email-send');
      btn.disabled = true;
      st.textContent = 'Sending...';
      api('POST', { action: 'email', email: email, marketing_opt_in: $('email-optin').checked }).then(function (r) {
        btn.disabled = false;
        st.textContent = r.ok ? 'Check your inbox. Tap the link on this phone. It works once and expires in 1 hour.' : (r.data.error || 'We could not send the email. Try again later.');
      }, function () {
        btn.disabled = false;
        st.textContent = 'No connection. Try again in a moment.';
      });
    });

    // Honor system: a follow or a download cannot be checked, so the
    // bonus unlocks when the player comes back from Instagram or the store.
    function honor(kind, url, statusId) {
      window.open(url, '_blank', 'noopener');
      var sent = false;
      function unlock() {
        if (sent) return;
        sent = true;
        document.removeEventListener('visibilitychange', onVis);
        api('POST', { action: kind }).then(function (r) {
          if (r.ok && r.data.state) render(r.data.state);
          else $(statusId).textContent = (r.data && r.data.error) || 'Could not unlock right now. Try again.';
        }, function () { sent = false; $(statusId).textContent = 'No connection. Try again.'; });
      }
      function onVis() { if (document.visibilityState === 'visible') unlock(); }
      document.addEventListener('visibilitychange', onVis);
      setTimeout(unlock, 8000);
    }
    $('ig-btn').addEventListener('click', function () {
      var st = S.state;
      if (st && st.instagram) honor('instagram', 'https://www.instagram.com/' + encodeURIComponent(st.instagram) + '/', 'ig-status');
    });
    $('app-btn').addEventListener('click', function () {
      var st = S.state;
      if (st && st.app_store_url && /^https:\/\/apps\.apple\.com\//.test(st.app_store_url)) honor('app', st.app_store_url, 'app-status');
    });

    // Skip for now: hide this quest card, keep every code. The trail and
    // a resume button stay, so they can carry on later.
    $('q-skip').addEventListener('click', function () {
      if (!S.state) return;
      uiSet({ skip: skipKey(S.state) });
      render(S.state);
      $('q-resume').focus();
    });
    $('q-resume').addEventListener('click', function () {
      uiSet({ skip: '' });
      if (S.state) render(S.state);
      $('q-title').setAttribute('tabindex', '-1');
      $('q-title').focus();
    });

    // "I don't need another app": one plain confirm, then the game ends
    // at 3. They keep their 3 pretzels.
    $('stop-btn').addEventListener('click', function () {
      $('stop-confirm').hidden = false;
      $('stop-yes').focus();
    });
    $('stop-no').addEventListener('click', function () {
      $('stop-confirm').hidden = true;
      $('stop-btn').focus();
    });
    $('stop-yes').addEventListener('click', function () {
      var btn = $('stop-yes');
      btn.disabled = true;
      api('POST', { action: 'stop' }).then(function (r) {
        btn.disabled = false;
        $('stop-confirm').hidden = true;
        if (r.data && r.data.state && r.data.state.game) render(r.data.state);
        if (!r.ok) { $('app-status').textContent = (r.data && r.data.error) || 'Could not end the game right now. Try again.'; return; }
        var t = $('g-end-title');
        t.setAttribute('tabindex', '-1');
        t.focus();
      }, function () {
        btn.disabled = false;
        $('app-status').textContent = 'No connection. Try again.';
      });
    });

  }

  // ─── welcome popup ────────────────────────────────────────────────
  // Logo and tagline, the offer headline slams in, the card rumbles.
  // "Pull a pretzel" closes it and shows the pack carousel behind it.
  function showPopup(st, preview) {
    var pop = $('g-pop');
    if (st && st.headline) $('g-pop-title').textContent = st.headline;
    var stamp = $('g-pop-stamp');
    stamp.textContent = (st && st.stamp) || '';
    stamp.hidden = !(st && st.stamp);
    pop.hidden = false;
    if (preview) { $('g-pop-go').disabled = true; return; }
    // The game screen is the top of the page; start there even if the
    // browser restored an old scroll position.
    window.scrollTo(0, 0);
    document.documentElement.classList.add('stage-open');
    var go = $('g-pop-go');
    go.focus({ preventScroll: true });
    if (reduced()) return;
    var title = $('g-pop-title'), card = $('g-pop-card');
    title.animate([
      { opacity: 0, transform: 'scale(3)' },
      { opacity: 1, transform: 'scale(0.94)', offset: 0.75 },
      { opacity: 1, transform: 'scale(1)' }
    ], { duration: 320, delay: 450, easing: 'ease-in', fill: 'backwards' });
    card.animate([
      { transform: 'translate(0, 0)' }, { transform: 'translate(-7px, 3px)' }, { transform: 'translate(6px, -3px)' },
      { transform: 'translate(-5px, 2px)' }, { transform: 'translate(4px, -1px)' }, { transform: 'translate(-2px, 1px)' },
      { transform: 'translate(0, 0)' }
    ], { duration: 380, delay: 700, easing: 'linear' });
    go.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250, delay: 1000, fill: 'backwards' });
    // Never leave the headline or button invisible if animations stall.
    setTimeout(function () {
      [title, card, go].forEach(function (n) { n.getAnimations().forEach(function (an) { try { an.finish(); } catch (e) {} }); });
    }, 1600);
  }
  function hidePopup() {
    var pop = $('g-pop');
    if (pop.hidden) return;
    var closed = false;
    var done = function () {
      if (closed) return;
      closed = true;
      pop.hidden = true;
      if ($('stage').hidden) document.documentElement.classList.remove('stage-open');
      var c = slots()[S.center];
      if (c) c.focus({ preventScroll: true });
      if (S.car) S.car.reset();
    };
    if (reduced() || !pop.animate) return done();
    pop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: 'ease-out', fill: 'forwards' }).onfinish = done;
    setTimeout(done, 400); // never leave the popup up if the animation stalls
    // Reset the fade so the popup shows normally if it is opened again.
    setTimeout(function () { pop.getAnimations().forEach(function (an) { an.cancel(); }); }, 450);
  }
  function initPopup() {
    $('g-pop-go').addEventListener('click', hidePopup);
    $('g-pop').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); hidePopup(); }
      if (e.key === 'Tab') { e.preventDefault(); $('g-pop-go').focus(); }
    });
  }

  function tryBadge(btnId, imgId, src) {
    var img = $(imgId);
    img.onload = function () { img.hidden = false; $(btnId).classList.add('has-badge'); };
    img.onerror = function () { img.removeAttribute('src'); };
    img.src = src;
  }

  // ─── boot ─────────────────────────────────────────────────────────
  function emailResult() {
    var m = /[?&]pack_email=([a-z]+)/.exec(location.search);
    if (!m) return;
    setMsg(EMAIL_MSG[m[1]] || '');
    try {
      var u = new URL(location.href);
      u.searchParams.delete('pack_email');
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    } catch (e) {}
  }

  // Magic link: the email's GET redirects here with #pack_verify=<token>.
  // Confirm with a same-origin POST, then drop the token from the URL.
  function verifyFromLink() {
    var m = /[#&]pack_verify=([A-Za-z0-9_-]{20,100})/.exec(location.hash);
    if (!m) return null;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    return api('POST', { action: 'verify', token: m[1] }).then(function (r) {
      setMsg(EMAIL_MSG[r.data && r.data.result] || (r.data && r.data.error) || EMAIL_MSG.invalid);
      if (r.ok && r.data.state && r.data.state.game) render(r.data.state);
    }, function () { setMsg('No connection. Open the link again in a moment.'); });
  }

  function boot() {
    if (!$('game')) return;
    // /ops/qr preview (srcdoc iframe): show the picker, never call the API.
    if (window.__OFFER_PREVIEW__ === true) {
      window.addEventListener('message', function (e) {
        if (e.source !== window.parent || e.origin !== window.origin || !e.data || e.data.type !== 'offer-preview') return;
        var on = !!(e.data.offer && e.data.offer.game && e.data.status !== 'ended');
        showGame(on);
        if (on) {
          renderPicker(null, true);
          showPopup({ headline: e.data.offer.headline, stamp: e.data.offer.stamp }, true);
          $('game-sub').textContent = 'Preview. Packs open on the live page.';
          $('vouchers').textContent = '';
          ['trail', 'quest', 'q-resume', 'g-end', 'set'].forEach(function (id) { $(id).hidden = true; });
        }
      });
      // Ask the panel to resend now that this listener exists (the inline
      // script's ready message can arrive before this deferred script runs).
      try { window.parent.postMessage({ type: 'offer-preview-ready' }, window.origin); } catch (err) {}
      return;
    }
    // The game screen is the top of the page: do not let the browser jump
    // back to an old scroll position on reload.
    try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch (e) {}
    initBonus();
    initRedeem();
    initPopup();
    api('GET', null, '&view=state', 2500).then(function (r) {
      if (!r.ok || !r.data || r.data.game !== true) return; // plain offer page
      showGame(true);
      render(r.data);
      // Welcome popup on a first visit; skipped when returning from an
      // email link or with packs already opened.
      var returning = /pack_email=|pack_verify=/.test(location.search + location.hash);
      if (r.data.can_open && r.data.used === 0 && !returning) showPopup(r.data);
      emailResult();
      verifyFromLink();
      FX.load();
      init3D();
      // Official badge artwork, if the files have been added. Text until then.
      tryBadge('ig-btn', 'ig-badge', ASSETS + 'instagram-glyph.svg');
      tryBadge('app-btn', 'app-badge', ASSETS + 'app-store-badge.svg');
    }).catch(function () { /* keep the plain offer page */ });
  }

  window.__ppfPacks = { stage: Stage, fx: FX, state: S };
  boot();
})();
