// The landing page sandbox and cost calculator. A simulation in the browser:
// nothing here talks to Salesforce or to an instance.
(function () {
  'use strict';
  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var POLL = 8, MAXWAIT = 3, OBJECTS = 12;
  var PROBE = { composite: Math.ceil(OBJECTS / 5), apex: Math.ceil(OBJECTS / 90), notifier: 0 };
  var IDLE = { composite: 1440 * PROBE.composite, apex: 1440 * PROBE.apex, notifier: 24 };

  var S = {
    t: 9 * 3600 + 58 * 60, watermark: 9 * 3600 + 58 * 60, next: POLL, fallback: 3600,
    source: 'composite', policy: 'sf_wins', calls: 0, busyIn: false, busyOut: false, batchAt: null,
    sf: [
      { sfid: '001Hu000032kX2QAAU', name: 'Northwind Trading', phone: '+1 415 555 0142' },
      { sfid: '001Hu000032kX2RAAU', name: 'Blue Harbor Foods', phone: '+1 206 555 0187' },
      { sfid: '001Hu000032kX2SAAU', name: 'Kestrel Labs', phone: '+44 20 7946 0958' }
    ],
    pg: [], dirty: {}, pending: [], seq: 418, done: {}
  };
  S.pg = S.sf.map(function (r, i) { return { id: i + 1, sfid: r.sfid, name: r.name, phone: r.phone }; });

  var $ = function (id) { return document.getElementById(id); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var fmt = function (s) { var h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60, x = s % 60; return [h, m, x].map(function (n) { return String(n).padStart(2, '0'); }).join(':'); };
  var num = function (n) { return Math.round(n).toLocaleString('en-US'); };
  var short = function (id) { return id ? id.slice(0, 6) + '…' + id.slice(-4) : '—'; };

  // ---------- tables ----------
  function rowHtml(side, r) {
    var key = side === 'sf' ? r.sfid : r.id;
    return '<tr data-key="' + key + '"><td class="id" title="' + (r.sfid || '') + '">' + short(r.sfid) + '</td>' +
      '<td><input aria-label="' + (side === 'sf' ? 'Salesforce Name' : 'PostgreSQL name') + '" data-side="' + side + '" data-key="' + key + '" data-field="name" value="' + r.name + '"></td>' +
      '<td class="ph"><input aria-label="' + (side === 'sf' ? 'Salesforce Phone' : 'PostgreSQL phone') + '" data-side="' + side + '" data-key="' + key + '" data-field="phone" value="' + r.phone + '"></td></tr>';
  }
  function cell(side, key, field) { return document.querySelector('input[data-side="' + side + '"][data-key="' + key + '"][data-field="' + field + '"]'); }
  function flash(el, side) { if (!el) return; el.classList.remove('flash-sf', 'flash-pg'); void el.offsetWidth; el.classList.add('flash-' + side); }
  function setCell(side, key, field, v) { var el = cell(side, key, field); if (el && document.activeElement !== el) el.value = v; flash(el, side); }
  function markDirty() {
    document.querySelectorAll('#sf-rows tr').forEach(function (tr) { tr.classList.toggle('dirty', !!S.dirty[tr.dataset.key]); });
    var n = Object.keys(S.dirty).length;
    $('sf-foot').innerHTML = n ? '<b>' + n + ' record' + (n > 1 ? 's' : '') + '</b> changed since the watermark at ' + fmt(S.watermark) + '. AlgoBridge hasn\'t seen ' + (n > 1 ? 'them' : 'it') + ' yet.'
      : 'Watermark <b>' + fmt(S.watermark) + '</b>. Nothing new in Salesforce.';
  }

  // ---------- log ----------
  function log(lv, proc, src, msg) {
    var ol = $('log'), li = document.createElement('li');
    li.className = 'new' + (lv === 'WRN' ? ' w' : '') + (lv === 'DBG' ? ' d' : '');
    li.innerHTML = '<span class="t">' + fmt(S.t) + '</span><span class="lv-' + lv + '">' + lv + '</span><span class="p">' + proc + '</span><span class="s s-' + src + '">' + src + '</span><span class="m"></span>';
    li.lastChild.textContent = msg;
    ol.appendChild(li);
    while (ol.children.length > 200) ol.removeChild(ol.firstChild);
    ol.scrollTop = ol.scrollHeight;
  }
  function mark(text) { var li = document.createElement('li'); li.className = 'mk'; li.textContent = text; $('log').appendChild(li); $('log').scrollTop = 1e9; }

  // ---------- lanes ----------
  function steps(dir, i) { var s = $('steps-' + dir).children; for (var k = 0; k < s.length; k++) s[k].classList.toggle('on', k === i); }
  function laneState(dir, label, cls) {
    var chip = $(dir + '-chip'); chip.textContent = label; chip.className = 'chip ' + cls;
    $('lane-' + dir).classList.toggle('quiet', cls === 'chip-idle');
  }
  function packet(dir, count) {
    if (REDUCED) return;
    var track = $('track-' + dir), w = track.clientWidth - 12;
    for (var i = 0; i < (count || 1); i++) (function (i) {
      var p = document.createElement('i'); p.className = 'pkt'; track.appendChild(p);
      var from = dir === 'in' ? 0 : w, to = dir === 'in' ? w : 0;
      var a = p.animate([{ transform: 'translateX(' + from + 'px)', opacity: 0 }, { opacity: 1, offset: .1 }, { opacity: 1, offset: .9 }, { transform: 'translateX(' + to + 'px)', opacity: 0 }],
        { duration: 900, delay: i * 180, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'both' });
      a.onfinish = function () { p.remove(); };
    })(i);
  }
  function probeRing() {
    if (REDUCED) return;
    var r = document.createElement('i'); r.className = 'ring'; $('track-in').appendChild(r);
    r.animate([{ transform: 'scale(.6)', opacity: 1 }, { transform: 'scale(2.2)', opacity: 0 }], { duration: 900, easing: 'ease-out' }).onfinish = function () { r.remove(); };
  }
  function addCalls(n) {
    if (!n) return;
    S.calls += n; var el = $('calls'); el.textContent = num(S.calls);
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
  }

  // ---------- change log ----------
  function hstore(p) { return '"' + p.field + '"=>"' + p.v + '"'; }
  function renderClog() {
    var live = S.pending;
    var n = live.filter(function (p) { return !p.sent; }).length;
    $('clog-count').textContent = n + ' pending';
    $('clog').innerHTML = live.length ? live.map(function (p) {
      return '<li class="' + (p.sent ? 'sent' : '') + '"><span>' + p.row + '</span><span class="op">' + p.op + '</span><span class="hs">' + (p.op === 'INSERT' ? '"name"=>"' + p.name + '"' : hstore(p)) + '</span><span class="st">' + (p.sent ? 'sent' : 'pending') + '</span></li>';
    }).join('') : '<li class="empty">no rows waiting</li>';
    $('out-note').textContent = n ? (S.batchAt ? 'batch sends in ' + Math.max(0, S.batchAt - S.t) + ' s, or at 200 rows' : 'sending') : 'nothing waiting';
  }

  // ---------- inbound: probe, fetch, apply ----------
  async function inbound(kind) {
    if (S.busyIn) return; S.busyIn = true;
    var dirtyIds = Object.keys(S.dirty);
    steps('in', 0); laneState('in', kind === 'notify' ? 'Notified' : 'Probing', 'chip-run');
    if (kind === 'notify') {
      log('INF', 'web', 'web', 'POST /notify/v1/changes: Account changed, signature valid, 0 API calls');
    } else {
      var c = PROBE[S.source === 'notifier' ? 'apex' : S.source];
      addCalls(c); probeRing();
      log('INF', 'worker', 'soql', 'probe ' + OBJECTS + ' objects in ' + c + ' call' + (c > 1 ? 's' : '') + ' (' + (S.source === 'composite' ? 'Composite, 5 objects a call' : 'Apex, 90 objects a call') + '): ' + (dirtyIds.length ? '1 changed' : 'nothing changed'));
    }
    await sleep(800);
    if (!dirtyIds.length) { steps('in', -1); laneState('in', 'Idle', 'chip-idle'); S.busyIn = false; return; }

    steps('in', 1); laneState('in', 'Fetching', 'chip-ok'); addCalls(1); packet('in', dirtyIds.length);
    log('INF', 'worker', 'soql', 'SELECT Id, Name, Phone, SystemModstamp FROM Account WHERE SystemModstamp > ' + fmt(S.watermark) + 'Z: ' + dirtyIds.length + ' record' + (dirtyIds.length > 1 ? 's' : '') + ' in 1 call');
    await sleep(950);

    steps('in', 2); laneState('in', 'Applying', 'chip-ok');
    var applied = 0;
    dirtyIds.forEach(function (sfid) {
      var row = S.pg.find(function (r) { return r.sfid === sfid; }); if (!row) return;
      Object.keys(S.dirty[sfid]).forEach(function (field) {
        var ch = S.dirty[sfid][field];
        var pend = S.pending.find(function (p) { return !p.sent && p.row === row.id && p.field === field; });
        var sfWins = true, why = '';
        if (pend) {
          if (S.policy === 'pg_wins') sfWins = false;
          if (S.policy === 'latest_wins') sfWins = ch.at > pend.at;
          why = S.policy + ': ' + (sfWins ? 'Salesforce value kept, the PostgreSQL change is dropped' : 'inbound write held back, the PostgreSQL value goes out in the next batch');
          log('WRN', 'worker', 'pg', 'conflict on Account ' + short(sfid) + ' ' + field + ': ' + why);
          if (sfWins) { S.pending = S.pending.filter(function (p) { return p !== pend; }); renderClog(); }
        }
        if (sfWins) { row[field] = ch.v; setCell('pg', row.id, field, ch.v); applied++; }
      });
    });
    if (applied) {
      log('INF', 'worker', 'pg', 'upsert crm.account: ' + applied + ' column' + (applied > 1 ? 's' : '') + ' written, matched on sfid, 0 API calls');
      log('DBG', 'worker', 'pg', 'ab.in_sync set for this transaction, so algobridge_capture_change skipped the rows: no echo');
    }
    S.watermark = S.t; S.dirty = {}; markDirty();
    await sleep(700);
    steps('in', -1); laneState('in', 'Idle', 'chip-idle'); S.busyIn = false;
  }

  // ---------- outbound: capture, batch, send ----------
  function capture(p) {
    S.pending.push(p); steps('out', 0); laneState('out', 'Captured', 'chip-run');
    log('INF', 'pg', 'pg', 'trigger algobridge_capture_change: ' + p.op + ' crm.account id=' + p.row + (p.field ? ' (' + p.field + ')' : '') + ', change ' + (++S.seq));
    if (!S.batchAt) S.batchAt = S.t + MAXWAIT;
    renderClog();
  }
  async function sendBatch() {
    if (S.busyOut) return;
    var items = S.pending.filter(function (p) { return !p.sent; });
    S.batchAt = null;
    if (!items.length) { laneState('out', 'Idle', 'chip-idle'); steps('out', -1); renderClog(); return; }
    S.busyOut = true;
    steps('out', 1); laneState('out', 'Batching', 'chip-run');
    log('DBG', 'worker', 'wkr', 'claimed ' + items.length + ' change' + (items.length > 1 ? 's' : '') + ' (oldest waited ' + MAXWAIT + ' s, the batch limit is 200)');
    await sleep(600);
    var ins = items.filter(function (p) { return p.op === 'INSERT'; }).length, upd = items.length - ins;
    steps('out', 2); laneState('out', 'Writing', 'chip-ok'); addCalls(1); packet('out', items.length);
    log('INF', 'worker', 'sf', 'SOAP ' + [ins ? 'create ' + ins : '', upd ? 'update ' + upd : ''].filter(Boolean).join(', ') + ' Account: ' + items.length + ' record' + (items.length > 1 ? 's' : '') + ' in 1 call');
    await sleep(950);
    items.forEach(function (p) {
      var row = S.pg.find(function (r) { return r.id === p.row; });
      if (p.op === 'INSERT') {
        var sfid = '001Hu000032kX' + String.fromCharCode(84 + S.sf.length) + 'AAU';
        row.sfid = sfid;
        S.sf.push({ sfid: sfid, name: row.name, phone: row.phone });
        $('sf-rows').insertAdjacentHTML('beforeend', rowHtml('sf', S.sf[S.sf.length - 1]));
        var tr = document.querySelector('#pg-rows tr[data-key="' + row.id + '"]');
        tr.firstChild.textContent = short(sfid); tr.firstChild.title = sfid; flash(tr.firstChild, 'pg');
        document.querySelectorAll('#sf-rows tr:last-child input').forEach(function (el) { flash(el, 'sf'); });
        log('INF', 'worker', 'pg', 'sfid ' + short(sfid) + ' written back to crm.account id=' + row.id + ', echo suppressed');
        done('insert');
      } else {
        var sr = S.sf.find(function (r) { return r.sfid === row.sfid; });
        if (sr) { sr[p.field] = p.v; setCell('sf', sr.sfid, p.field, p.v); }
      }
      p.sent = true;
    });
    renderClog();
    await sleep(1400);
    S.pending = S.pending.filter(function (p) { return !p.sent; }); renderClog();
    steps('out', -1); laneState('out', S.pending.length ? 'Captured' : 'Idle', S.pending.length ? 'chip-run' : 'chip-idle');
    S.busyOut = false;
  }

  // ---------- edits ----------
  function commit(side, key, field, v) {
    if (side === 'sf') {
      var r = S.sf.find(function (x) { return x.sfid === key; }); if (!r || r[field] === v) return;
      r[field] = v; (S.dirty[key] = S.dirty[key] || {})[field] = { v: v, at: S.t };
      markDirty(); done('sf');
      if (S.source === 'notifier') setTimeout(function () { inbound('notify'); }, 1100);
    } else {
      var row = S.pg.find(function (x) { return String(x.id) === String(key); }); if (!row || row[field] === v) return;
      row[field] = v;
      var ins = S.pending.find(function (p) { return !p.sent && p.op === 'INSERT' && p.row === row.id; });
      if (ins) { ins.name = row.name; renderClog(); return; }
      capture({ row: row.id, op: 'UPDATE', field: field, v: v, at: S.t });
      done('pg');
    }
  }
  document.addEventListener('change', function (e) {
    var el = e.target; if (!el.dataset || !el.dataset.side) return;
    commit(el.dataset.side, el.dataset.key, el.dataset.field, el.value.trim());
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.dataset && e.target.dataset.side) e.target.blur(); });

  function setSource(src) {
    if (S.source === src) return;
    S.source = src;
    document.querySelectorAll('[data-src]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.src === src)); });
    var label = { composite: 'Composite probe: 5 objects a call', apex: 'Apex probe: 90 objects a call', notifier: 'change notifier: Salesforce tells AlgoBridge, 0 calls a change' }[src];
    mark('change source is now the ' + label);
    S.next = POLL; tickNote();
    $('pollbar').classList.toggle('off', src === 'notifier'); if (src !== 'notifier') restartPollbar(POLL);
    countUp($('idle'), IDLE[src], 700);
    if (src === 'notifier') done('notifier');
  }
  document.querySelectorAll('[data-src]').forEach(function (b) { b.addEventListener('click', function () { setSource(b.dataset.src); }); });
  $('policy').addEventListener('change', function (e) { S.policy = e.target.value; mark('conflict policy is now ' + S.policy); });

  // ---------- guided tour ----------
  function done(task) {
    if (S.done[task]) return; S.done[task] = true;
    var li = document.querySelector('.tour li[data-task="' + task + '"]'); if (li) li.classList.add('done');
    $('tour-count').textContent = Object.keys(S.done).length + ' of 5';
  }
  var demos = {
    sf: function () { var el = cell('sf', S.sf[1].sfid, 'phone'); el.value = '+1 206 555 0' + (100 + Math.floor(Math.random() * 899)); commit('sf', S.sf[1].sfid, 'phone', el.value); flash(el, 'sf'); },
    pg: function () { var r = S.pg[2], el = cell('pg', r.id, 'name'); el.value = r.name.indexOf('Ltd') < 0 ? r.name + ' Ltd' : r.name.replace(' Ltd', ''); commit('pg', r.id, 'name', el.value); flash(el, 'pg'); },
    insert: function () {
      var id = S.pg.length + 1, names = ['Juniper Analytics', 'Halcyon Freight', 'Orchard Row Bakery', 'Tidewater Clinics'];
      var row = { id: id, sfid: null, name: names[(id - 4) % names.length], phone: '+1 312 555 01' + (10 + id) };
      S.pg.push(row); $('pg-rows').insertAdjacentHTML('beforeend', rowHtml('pg', row));
      document.querySelectorAll('#pg-rows tr:last-child input').forEach(function (el) { flash(el, 'pg'); });
      capture({ row: id, op: 'INSERT', name: row.name, at: S.t });
    },
    conflict: function () {
      var sr = S.sf[0], pr = S.pg[0];
      var a = '+1 415 555 01' + (10 + Math.floor(Math.random() * 89)), b = '+1 415 555 02' + (10 + Math.floor(Math.random() * 89));
      cell('sf', sr.sfid, 'phone').value = a; commit('sf', sr.sfid, 'phone', a); flash(cell('sf', sr.sfid, 'phone'), 'sf');
      setTimeout(function () {
        S.t++; cell('pg', pr.id, 'phone').value = b; commit('pg', pr.id, 'phone', b); flash(cell('pg', pr.id, 'phone'), 'pg');
        mark('one record changed on both sides, policy ' + S.policy);
        if (S.source !== 'notifier') { S.next = 1; restartPollbar(1); }
        done('conflict');
      }, 400);
    },
    notifier: function () { setSource('notifier'); setTimeout(demos.sf, 600); }
  };
  document.querySelectorAll('[data-do]').forEach(function (b) { b.addEventListener('click', function () { if (S.ready) demos[b.dataset.do](); }); });

  // ---------- clock ----------
  function tickNote() {
    $('in-note').textContent = S.source === 'notifier'
      ? 'waiting for a notification. Fallback poll in ' + Math.floor(S.fallback / 60) + ':' + String(S.fallback % 60).padStart(2, '0')
      : (S.busyIn ? 'probe running' : 'next probe in ' + S.next + ' s');
  }
  function startClock() { setInterval(function () {
    S.t++;
    if (S.source === 'notifier') { S.fallback = S.fallback > 0 ? S.fallback - 1 : 3600; }
    else if (!S.busyIn && --S.next <= 0) { S.next = POLL; inbound('poll'); restartPollbar(POLL); }
    if (S.batchAt && S.t >= S.batchAt) sendBatch();
    tickNote(); if (S.batchAt) renderClog();
  }, 1000); }

  // ---------- boot: the sandbox starts like a real instance ----------
  function countUp(el, to, ms) {
    var from = el._v || 0; el._v = to;
    if (REDUCED || !ms) { el.textContent = num(to); return; }
    var t0 = performance.now();
    (function f(now) { var k = Math.min(1, (now - t0) / ms); k = 1 - Math.pow(1 - k, 3); el.textContent = num(from + (to - from) * k); if (k < 1) requestAnimationFrame(f); })(t0);
  }
  function flip(chip, label, cls) { chip.textContent = label; chip.className = 'chip ' + cls; void chip.offsetWidth; chip.classList.add('flip'); }
  async function addRows(side) {
    var body = $(side + '-rows'), list = S[side];
    for (var i = 0; i < list.length; i++) { body.insertAdjacentHTML('beforeend', rowHtml(side, list[i])); if (!REDUCED) await sleep(110); }
  }
  async function boot() {
    var wait = function (ms) { return REDUCED ? Promise.resolve() : sleep(ms); };
    flip($('health'), 'Starting', 'chip-run'); $('idle').textContent = '0';
    renderClog(); markDirty(); $('in-note').textContent = 'starting'; $('pollbar').classList.add('off');
    await wait(1500);
    mark('Connected at ' + fmt(S.t) + ' UTC. Nothing earlier is shown');
    var lines = [
      ['INF', 'web', 'web', 'listening on :3000, APP_ROLE=all'],
      ['INF', 'worker', 'pg', 'platform database migrated, nothing pending'],
      ['INF', 'worker', 'wkr', 'job queue ready in schema algobridge_jobs, 2 workers'],
      ['INF', 'worker', 'sf', 'Salesforce org reachable: 41,280 of 100,000 API calls used today (41%)'],
      ['INF', 'worker', 'pg', 'client database reachable: crm.account, 3 rows'],
      ['INF', 'worker', 'wkr', 'mapping Account active: read-write, policy sf_wins, polling every 1–15 min']
    ];
    for (var i = 0; i < lines.length; i++) {
      await wait(260); S.t++;
      log.apply(null, lines[i]);
      if (i === 3) { addCalls(1); addRows('sf'); }
      if (i === 4) addRows('pg');
    }
    await wait(500);
    flip($('health'), 'Healthy', 'chip-ok');
    countUp($('idle'), IDLE[S.source], 900);
    markDirty();
    S.next = 3; $('pollbar').classList.remove('off'); restartPollbar(3);
    tickNote(); startClock(); S.ready = true;
  }
  function restartPollbar(sec) {
    var i = $('pollbar').firstChild; i.classList.remove('run'); void i.offsetWidth;
    i.style.setProperty('--poll', sec + 's'); i.classList.add('run');
  }
  boot();

  // ---------- cost calculator ----------
  var INTS = [30, 60, 300, 600, 900], INT_L = ['30 s', '1 min', '5 min', '10 min', '15 min'];
  var vol = function (x) { return x === 0 ? 0 : Math.round(Math.pow(10, x / 25) * 50 / 50) * 50; }; // 0..100 -> 0..500k, log scale
  function calc() {
    var n = +$('c-obj').value, iv = INTS[+$('c-int').value], sf = vol(+$('c-sf').value), pg = vol(+$('c-pg').value), lim = +$('c-lim').value * 1000;
    $('o-obj').textContent = n; $('o-int').textContent = INT_L[+$('c-int').value]; $('o-sf').textContent = num(sf); $('o-pg').textContent = num(pg); $('o-lim').textContent = num(lim);
    var polls = 86400 / iv;
    var fetch = sf ? Math.max(Math.min(polls, sf), Math.ceil(sf / 500)) : 0;
    var sends = pg ? Math.max(Math.ceil(pg / 200), Math.min(pg, 1440)) : 0;
    var rows = [
      { k: 'Composite probe', d: 'Nothing to install', probe: polls * Math.ceil(n / 5), how: num(polls) + ' polls × ' + Math.ceil(n / 5) + ' probe calls' },
      { k: 'Apex probe', d: 'Deploy the Apex bundle', probe: polls * Math.ceil(n / 90), how: num(polls) + ' polls × ' + Math.ceil(n / 90) + ' probe call' + (Math.ceil(n / 90) > 1 ? 's' : '') },
      { k: 'Change notifier', d: 'Bundle plus Flows', probe: 24 * Math.ceil(n / 90), how: '24 fallback polls × ' + Math.ceil(n / 90) + ' call' + (Math.ceil(n / 90) > 1 ? 's' : '') }
    ];
    rows.forEach(function (r) { r.total = r.probe + fetch + sends; });
    var best = rows.reduce(function (a, b) { return b.total < a.total ? b : a; });
    var box = $('results');
    if (!box.children.length) box.innerHTML = rows.map(function (r) {
      return '<div class="res"><div class="name">' + r.k + '<small>' + r.d + '</small><span class="flag"></span></div>' +
        '<div class="bar"><i></i><span class="m"></span><span class="m h"></span></div>' +
        '<div class="num"><b class="tnum">0</b><small></small></div><div class="how"></div></div>';
    }).join('');
    rows.forEach(function (r, i) {
      var el = box.children[i], pct = r.total / lim * 100;
      el.classList.toggle('best', r === best);
      el.querySelector('.flag').innerHTML = pct >= 90 ? '<span class="chip chip-warn">Paused at 90%</span>' : pct >= 70 ? '<span class="chip chip-warn">Slowed at 70%</span>' : r === best ? '<span class="chip chip-ok">Lowest</span>' : '';
      el.querySelector('.how').textContent = r.how + ' + ' + num(fetch) + ' fetches + ' + num(sends) + ' SOAP sends';
      el.querySelector('.num small').textContent = 'calls a day, ' + pct.toFixed(pct < 10 ? 1 : 0) + '% of limit';
      if (!shown) return;
      el.querySelector('.bar i').style.transform = 'scaleX(' + Math.min(1, pct / 100) + ')';
      countUp(el.querySelector('.num b'), r.total, first ? 1100 : 250);
    });
    if (shown) first = false;
  }
  var shown = false, first = true;
  ['c-obj', 'c-int', 'c-sf', 'c-pg', 'c-lim'].forEach(function (id) { $(id).addEventListener('input', calc); });
  if ('IntersectionObserver' in window && !REDUCED) {
    new IntersectionObserver(function (es, o) { if (es[0].isIntersecting) { shown = true; calc(); o.disconnect(); } }, { threshold: .35 }).observe($('results'));
  } else { shown = true; }
  calc();
})();
