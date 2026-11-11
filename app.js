import * as F from './src/fabric.js';

const $ = id => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const S = { round: null, rail: qs.has('rail') ? +qs.get('rail') : -1, comp: qs.has('comp') ? +qs.get('comp') : null, side: qs.get('side') || 'plan', hlNodes: [] };
const fmtP = p => p >= 0.995 ? '>99%' : p < 0.001 ? '<0.1%' : p < 0.1 ? (p * 100).toFixed(1) + '%' : Math.round(p * 100) + '%';
const gbps = x => Math.round(x * 400);
const icons = () => window.lucide && window.lucide.createIcons();
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let sc, topo, AD, RD, nextPlanCache = null;

async function main() {
  icons();
  sc = await (await fetch('data/scenario.json')).json();
  topo = F.buildTopology(sc);
  $('cluster-name').textContent = sc.clusterName;
  $('cluster-meta').textContent = `${topo.N} × ${sc.sku} nodes · ${topo.P} pods · ${topo.rails} rails · ${sc.lineGbps}G RoCE`;
  AD = F.createCampaign(topo, sc, { strategy: 'adaptive', stopWhenResolved: false, maxRounds: 8 });
  RD = F.createCampaign(topo, sc, { strategy: 'random', stopWhenResolved: false, maxRounds: 8 });
  await new Promise(res => {
    const tick = () => {
      if (!AD.done) { $('loading-text').textContent = `Running round ${AD.rounds.length + 1} of planned pair tests…`; AD.step(); }
      else if (!RD.done) { $('loading-text').textContent = `Replaying random shakedown pairs for comparison (round ${RD.rounds.length + 1})…`; RD.step(); }
      else return res();
      setTimeout(tick, 0);
    };
    tick();
  });
  $('loading').style.display = 'none';
  const nR = AD.rounds.length;
  S.round = qs.has('round') ? Math.max(1, Math.min(nR, +qs.get('round'))) : nR;
  setupControls();
  render();
}

function setupControls() {
  const rs = $('round-select');
  rs.innerHTML = AD.rounds.map(r => `<option value="${r.round}">After round ${r.round} of ${AD.rounds.length}</option>`).join('');
  rs.onchange = () => { S.round = +rs.value; render(); };
  $('prev-round').onclick = () => { if (S.round > 1) { S.round--; render(); } };
  $('next-round').onclick = () => { if (S.round < AD.rounds.length) { S.round++; render(); } };
  const rails = $('rail-select');
  rails.innerHTML = `<option value="-1">All rails</option>` + Array.from({ length: topo.rails }, (_, r) => `<option value="${r}">rdma${r}</option>`).join('');
  rails.value = S.rail;
  rails.onchange = () => { S.rail = +rails.value; renderMap(cur()); };
  document.querySelectorAll('.side-tabs button').forEach(b => b.onclick = () => { S.side = b.dataset.side; renderSide(cur()); });
}

const cur = () => AD.rounds[S.round - 1];
const curRandom = () => RD.rounds[Math.min(S.round, RD.rounds.length) - 1];

function compState(R, c) {
  if (!R.nObsComp[c]) return 'untested';
  if (R._conf.has(c)) return 'confirmed';
  if (R._masked.has(c)) return 'masked';
  const p = R.post[c];
  if (p >= F.SUSPECT) return 'suspect';
  if (p > F.CLEAR) return 'watch';
  return 'cleared';
}
function prep(R) {
  if (R._prepped) return;
  R._conf = new Set(R.confirmed);
  R._masked = new Map(R.masked.map(m => [m.comp, m.by]));
  R._amb = new Map();
  R.ambiguous.forEach((g, k) => g.comps.forEach(c => R._amb.set(c, k)));
  R._prepped = true;
}

function render() {
  const R = cur(); prep(R);
  $('round-select').value = S.round;
  renderStats(R, curRandom());
  renderMap(R);
  renderSide(R);
  renderFindings(R);
  renderChart(R);
  renderLog(R);
  icons();
  const u = new URL(location.href);
  u.searchParams.set('round', S.round);
  if (S.comp != null) u.searchParams.set('comp', S.comp); else u.searchParams.delete('comp');
  history.replaceState(null, '', u);
}

function typeCounts(list) {
  const n = { nic: 0, leaf: 0, uplink: 0 };
  list.forEach(c => n[topo.comps[c].type]++);
  const parts = [];
  if (n.nic) parts.push(`${n.nic} NIC rail${n.nic > 1 ? 's' : ''}`);
  if (n.leaf) parts.push(`${n.leaf} leaf switch${n.leaf > 1 ? 'es' : ''}`);
  if (n.uplink) parts.push(`${n.uplink} spine uplink${n.uplink > 1 ? 's' : ''}`);
  return parts.join(' · ') || 'none yet';
}

function renderStats(R, RR) {
  const open = R.suspect.length;
  const maskedCount = R.masked.length;
  $('stats').innerHTML = `
  <div class="card stat">
    <div class="card-title"><span class="ico red"><i data-lucide="circle-x"></i></span>Confirmed faults</div>
    <div class="big c-red">${R.confirmed.length}<small>P(fault) ≥ ${Math.round(F.CONFIRM * 100)}%</small></div>
    <div class="sub">${typeCounts(R.confirmed)}${R.ambiguous.length ? ` · ${R.ambiguous.length} either/or` : ''}</div>
  </div>
  <div class="card stat">
    <div class="card-title"><span class="ico green"><i data-lucide="server"></i></span>Healthy nodes blamed</div>
    <div class="big c-green">${R.score.healthyBlamed}<small>of ${R.blamedNodes.length} drains recommended</small></div>
    <div class="sub">Checked against the simulated ground truth. A slow-pair vote on the same ${RR.round} rounds of shakedown blamed <b class="c-fg">${RR.voteScore.healthyBlamed}</b> healthy nodes.</div>
  </div>
  <div class="card stat">
    <div class="card-title"><span class="ico teal"><i data-lucide="arrow-left-right"></i></span>Pair tests run</div>
    <div class="big c-fg">${R.testsTotal}<small>${R.round} round${R.round > 1 ? 's' : ''} · ${R.nObs.toLocaleString()} rail results</small></div>
    <div class="sub">Random shakedown pairs: ${RR.testsTotal} tests for ${RR.confirmed.length} confirmed faults by round ${RR.round}.</div>
  </div>
  <div class="card stat">
    <div class="card-title"><span class="ico amber"><i data-lucide="circle-help"></i></span>Still open</div>
    <div class="big c-amber">${open}<small>suspect${open === 1 ? '' : 's'} · ${R.watch.length} on watch</small></div>
    <div class="sub">${maskedCount} component${maskedCount === 1 ? '' : 's'} masked behind confirmed faults${R.untestedNic ? ` · ${R.untestedNic} NIC rails untested (allocated to jobs)` : ' · every NIC rail tested'}.</div>
  </div>`;
}

const STATE_LABEL = { cleared: 'Cleared', watch: 'Watch (1–5%)', suspect: 'Suspect', confirmed: 'Confirmed', masked: 'Masked', untested: 'Untested' };
function renderMap(R) {
  prep(R);
  $('legend').innerHTML = ['cleared', 'watch', 'suspect', 'confirmed', 'masked', 'untested']
    .map(s => `<span><i class="cell st-${s}" style="width:10px;height:10px;display:inline-block;cursor:default"></i>${STATE_LABEL[s]}</span>`).join('');
  const hl = new Set(S.hlNodes);
  let html = '';
  for (let p = 0; p < topo.P; p++) {
    const podNodes = topo.nodes.filter(n => n.pod === p);
    let conf = 0, sus = 0;
    for (const n of podNodes) for (let r = 0; r < topo.rails; r++) { const st = compState(R, topo.nicId(n.id, r)); if (st === 'confirmed') conf++; if (st === 'suspect') sus++; }
    html += `<div class="pod"><div class="pod-head"><b>${topo.cluster}-${sc.pods[p]}</b><span class="muted small">${podNodes.length} nodes${conf ? ` · <span class="c-red">${conf} confirmed</span>` : ''}${sus ? ` · <span class="c-amber">${sus} suspect</span>` : ''}</span></div><div class="pod-grid">`;
    html += `<span></span>` + podNodes.map(n => `<span class="colhead">${n.g % 4 === 1 ? 'g' + n.g : ''}</span>`).join('') + `<span></span><span class="colhead sw2">leaf · up</span>`;
    for (let r = 0; r < topo.rails; r++) {
      const dim = S.rail >= 0 && S.rail !== r ? ' dim' : '';
      html += `<span class="lab">rdma${r}</span>`;
      for (const n of podNodes) {
        const c = topo.nicId(n.id, r);
        html += `<span class="cell st-${compState(R, c)}${dim}${S.comp === c ? ' sel' : ''}${hl.has(n.id) ? ' hl' : ''}" data-c="${c}"></span>`;
      }
      const lc = topo.leafId(p, r), uc = topo.upId(p, r);
      html += `<span></span><span class="cell sw st-${compState(R, lc)}${dim}${S.comp === lc ? ' sel' : ''}" data-c="${lc}"></span><span class="cell sw st-${compState(R, uc)}${dim}${S.comp === uc ? ' sel' : ''}" data-c="${uc}"></span>`;
    }
    html += `</div></div>`;
  }
  $('map').innerHTML = html;
  const tip = $('tip');
  $('map').querySelectorAll('.cell').forEach(el => {
    const c = +el.dataset.c;
    el.onmouseenter = e => {
      const comp = topo.comps[c], st = compState(R, c);
      const ev = F.evidenceFor(topo, R.inf, AD.obs, c);
      const blk = R._masked.get(c);
      tip.innerHTML = `<div class="t-title">${esc(comp.name)}</div>
        <div>${STATE_LABEL[st]}${st === 'masked' ? ` by ${esc(topo.comps[blk].name)}` : ''}</div>
        <div>P(fault) <b class="${st === 'confirmed' ? 't-red' : st === 'suspect' || st === 'watch' ? 't-amber' : 't-teal'}">${R.nObsComp[c] ? fmtP(R.post[c]) : 'prior ' + fmtP(F.priorOf(comp))}</b></div>
        <div class="muted">${ev.n ? `${ev.slow} of ${ev.n} tests slow${ev.medianSlowGbps ? ` · median slow ${Math.round(ev.medianSlowGbps)} Gb/s` : ''}` : 'Not tested yet'}</div>`;
      tip.style.opacity = 1; moveTip(e);
    };
    el.onmousemove = moveTip;
    el.onmouseleave = () => { tip.style.opacity = 0; };
    el.onclick = () => selectComp(c);
  });
}
function moveTip(e) {
  const tip = $('tip');
  const x = Math.min(window.innerWidth - tip.offsetWidth - 12, e.clientX + 14);
  tip.style.left = x + 'px'; tip.style.top = (e.clientY + 16) + 'px';
}
function selectComp(c) {
  S.comp = c; S.side = 'detail';
  render();
}

// ------------------------------------------------------------- side panel
function planFor(R) {
  if (R.round < AD.rounds.length) return { round: R.round + 1, tests: AD.rounds[R.round].tests, idle: AD.rounds[R.round].idleCount };
  if (!nextPlanCache) {
    const idle = F.idleNodes(topo, F.indexScenario(sc), R.round + 1);
    nextPlanCache = { round: R.round + 1, tests: AD.next(idle), idle: idle.length };
  }
  return nextPlanCache;
}
function reasonFor(R, t) {
  const untested = n => { for (let r = 0; r < topo.rails; r++) if (R.nObsComp[topo.nicId(n, r)]) return false; return true; };
  if (untested(t.i) || untested(t.j)) {
    const n = untested(t.i) ? t.i : t.j;
    return `First test for ${topo.nodes[n].name}: it was allocated to a job until now`;
  }
  let best = null, bestScore = 0;
  const intra = topo.nodes[t.i].pod === topo.nodes[t.j].pod;
  for (let r = 0; r < topo.rails; r++) for (const c of topo.pathComps(t.i, t.j, r)) {
    if (R._conf.has(c) || R._masked.has(c)) continue;
    const p = R.post[c];
    const s = Math.min(p, 1 - p);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  if (!best) return 'Coverage on rails with few clean results';
  const comp = topo.comps[best];
  if (comp.type !== 'nic') return `${intra ? 'Intra-pod pair: separates' : 'Cross-pod pair: tests'} ${comp.name} (${fmtP(R.post[best])})`;
  const partner = comp.node === t.i ? t.j : t.i;
  let partnerClean = true;
  for (let r = 0; r < topo.rails; r++) if (R.post[topo.nicId(partner, r)] > F.CLEAR) partnerClean = false;
  return `Retest ${comp.name.split(' · ')[0]} rdma${comp.rail} (${fmtP(R.post[best])})${partnerClean ? ' vs. a cleared node' : ''}`;
}
function renderSide(R) {
  document.querySelectorAll('.side-tabs button').forEach(b => b.classList.toggle('active', b.dataset.side === S.side));
  if (S.side === 'detail' && S.comp != null) return renderDetail(R, S.comp);
  if (S.side === 'detail') { $('side').innerHTML = `<div class="side-sum">Click any cell in the fabric map or a row in Findings to see its evidence.</div>`; return; }
  const plan = planFor(R);
  const bits = plan.tests.reduce((a, t) => a + t.bits, 0);
  const show = plan.tests;
  $('side').innerHTML = `
    <div class="side-sum">Round ${plan.round} plan: <b>${plan.tests.length} pair tests</b> on ${plan.idle} idle nodes, ${bits.toFixed(1)} bits expected. Pairs worth under 0.05 bits are skipped, so cleared nodes stay free for jobs.</div>
    <div class="plan-list">${show.map((t, k) => `
      <div class="plan-item" data-k="${k}">
        <span class="pair">${topo.nodes[t.i].name.replace(topo.cluster + '-', '')} ↔ ${topo.nodes[t.j].name.replace(topo.cluster + '-', '')}</span>
        <span class="bits">${t.bits.toFixed(2)} bits</span>
        <span class="why">${esc(reasonFor(R, t))}</span>
      </div>`).join('')}
    </div>
    <button class="btn primary" id="run-next" ${R.round >= AD.rounds.length ? 'disabled title="Demo ends at round 8"' : ''}>${R.round >= AD.rounds.length ? 'Queued for next maintenance window' : `Run round ${plan.round}`}<i data-lucide="${R.round >= AD.rounds.length ? 'clock' : 'play'}"></i></button>`;
  $('side').querySelectorAll('.plan-item').forEach(el => {
    const t = show[+el.dataset.k];
    el.onmouseenter = () => { S.hlNodes = [t.i, t.j]; renderMap(R); };
    el.onmouseleave = () => { S.hlNodes = []; renderMap(R); };
  });
  const btn = $('run-next');
  if (btn && R.round < AD.rounds.length) btn.onclick = () => { S.round++; render(); };
  icons();
}

function diagnose(R, c) {
  const comp = topo.comps[c];
  const list = R.inf.compObs[c];
  const obs = list.map(o => AD.obs[o]);
  const slow = obs.filter(o => o.x < F.MODEL.slowThr);
  const med = slow.length ? slow.map(o => o.x).sort((a, b) => a - b)[Math.floor(slow.length / 2)] : null;
  const pod = `${topo.cluster}-${sc.pods[comp.pod]}`;
  if (comp.type === 'nic') {
    const node = topo.nodes[comp.node].name;
    const flaky = R.postFlaky[c] > 0.5 * R.post[c];
    if (flaky) return { dx: `Slow on ${slow.length} of ${obs.length} tests (median ${gbps(med)} Gb/s) and clean on the rest: intermittent, like a flapping link`, action: `Check link-flap and symbol-error counters on rdma${comp.rail}; replace the cable if they move` };
    if (med != null && med < 0.6) return { dx: `${gbps(med)} Gb/s median on ${slow.length} of ${obs.length} tests, about half of line rate: one lane down`, action: `Drain ${node}; replace the rdma${comp.rail} optic` };
    return { dx: `${med ? gbps(med) : '-'} Gb/s median on ${slow.length} of ${obs.length} tests while its partners test clean elsewhere: degraded link (CRC/FEC errors likely)`, action: `Drain ${node}; reseat the rdma${comp.rail} optic and retest` };
  }
  const nodesHit = new Set(), intra = [], cross = [];
  for (const o of obs) {
    const inPod = topo.nodes[o.i].pod === comp.pod ? o.i : o.j;
    if (o.x < F.MODEL.slowThr) nodesHit.add(inPod);
    (topo.nodes[o.i].pod === topo.nodes[o.j].pod ? intra : cross).push(o);
  }
  if (comp.type === 'leaf') {
    const si = intra.filter(o => o.x < F.MODEL.slowThr).length;
    return { dx: `${slow.length} of ${obs.length} tests through it slow (median ${med ? gbps(med) : '-'} Gb/s) across ${nodesHit.size} different nodes; intra-pod pairs slow too (${si}/${intra.length}). No set of NICs explains that better`, action: `Network ticket: ${pod} leaf, rail ${comp.rail} (port buffers / PFC). Do not swap the ${nodesHit.size} nodes` };
  }
  // uplink: compare with intra-pod tests on the same leaf
  const leafObs = R.inf.compObs[topo.leafId(comp.pod, comp.rail)].map(o => AD.obs[o]).filter(o => topo.nodes[o.i].pod === topo.nodes[o.j].pod);
  const ls = leafObs.filter(o => o.x < F.MODEL.slowThr).length;
  return { dx: `Cross-pod tests on plane ${comp.rail} slow (${slow.length}/${obs.length}, median ${med ? gbps(med) : '-'} Gb/s) while intra-pod tests on the same leaf are clean (${ls}/${leafObs.length} slow)`, action: `Check ${pod} leaf → spine uplinks on plane ${comp.rail}; only cross-pod traffic on rail ${comp.rail} is affected` };
}

function renderDetail(R, c) {
  const comp = topo.comps[c];
  const st = compState(R, c);
  const hist = AD.rounds.map(r => r.post[c]);
  const W = 340, H = 80, pad = 6;
  const xs = k => pad + k * (W - 2 * pad) / Math.max(1, hist.length - 1);
  const ys = p => H - pad - p * (H - 2 * pad);
  const pts = hist.map((p, k) => `${xs(k).toFixed(1)},${ys(p).toFixed(1)}`).join(' ');
  const list = R.inf.compObs[c].map(o => AD.obs[o]).sort((a, b) => a.round - b.round);
  const dg = R.nObsComp[c] && st !== 'masked' ? diagnose(R, c) : null;
  $('side').innerHTML = `
    <div class="detail-title">${esc(comp.name)}</div>
    <div><span class="pill"><span class="dot" style="background:${st === 'confirmed' ? 'var(--status-error)' : st === 'suspect' || st === 'watch' ? 'var(--status-warning)' : st === 'cleared' ? 'var(--brand-teal)' : 'var(--accent)'}"></span>${STATE_LABEL[st]}</span></div>
    <div class="kv">
      <span>P(fault)</span><span>${R.nObsComp[c] ? fmtP(R.post[c]) : 'prior ' + fmtP(F.priorOf(comp))}</span>
      <span>P(flapping)</span><span>${R.nObsComp[c] ? fmtP(R.postFlaky[c]) : '-'}</span>
      <span>Tests through it</span><span>${R.nSlowComp[c]} slow / ${R.nObsComp[c]}</span>
      ${st === 'masked' ? `<span>Masked by</span><span>${esc(topo.comps[R._masked.get(c)].name.replace(topo.cluster + '-', ''))}</span>` : ''}
    </div>
    <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <line x1="${pad}" x2="${W - pad}" y1="${ys(F.CONFIRM)}" y2="${ys(F.CONFIRM)}" stroke="#ff4072" stroke-dasharray="3 3" opacity=".6"/>
      <line x1="${pad}" x2="${W - pad}" y1="${ys(0)}" y2="${ys(0)}" stroke="#262b2b"/>
      <polyline points="${pts}" fill="none" stroke="#0de2f2" stroke-width="1.6"/>
      ${hist.map((p, k) => `<circle cx="${xs(k)}" cy="${ys(p)}" r="${k === S.round - 1 ? 3.5 : 2}" fill="${k === S.round - 1 ? '#f9fafa' : '#0de2f2'}"/>`).join('')}
    </svg>
    <div class="muted small" style="margin-top:-6px">P(fault) after each round · dashed line = confirm threshold</div>
    ${dg ? `<div class="side-sum"><b>Diagnosis.</b> ${esc(dg.dx)}.<br><b>Action.</b> ${esc(dg.action)}.</div>` : st === 'masked' ? `<div class="side-sum">Every test through it also crossed a confirmed fault, so its own health is unknown. Retest after that fault is repaired.</div>` : ''}
    <div class="obs-list">${list.map(o => {
      const partner = comp.type === 'nic' ? (o.i === comp.node ? o.j : o.i) : null;
      const label = comp.type === 'nic' ? topo.nodes[partner].name.replace(topo.cluster + '-', '') : `${topo.nodes[o.i].name.replace(topo.cluster + '-', '')}↔${topo.nodes[o.j].name.replace(topo.cluster + '-', '')}`;
      return `<div class="${o.x < F.MODEL.slowThr ? 'slow' : ''}"><span>R${o.round} ${comp.type === 'nic' ? '↔ ' : ''}${label}${comp.type === 'nic' ? '' : ' r' + o.r}</span><span>${gbps(o.x)} Gb/s</span></div>`;
    }).join('') || '<div class="muted">No tests yet</div>'}</div>`;
}

// ------------------------------------------------------------- findings
function pbar(p, color) {
  return `<div class="pbar"><div class="track"><i style="width:${Math.max(2, p * 100)}%;background:${color}"></i></div><span>${fmtP(p)}</span></div>`;
}
const TYPE = { nic: 'NIC rail', leaf: 'Leaf switch', uplink: 'Spine uplink' };
function renderFindings(R) {
  const rows = [];
  const confSorted = R.confirmed.slice().sort((a, b) => (topo.comps[a].type === 'nic') - (topo.comps[b].type === 'nic') || R.post[b] - R.post[a]);
  for (const c of confSorted) rows.push({ c, status: 'Confirmed', color: 'var(--status-error)' });
  R.ambiguous.forEach(g => g.comps.forEach(c => rows.push({ c, status: 'Either/or', color: 'var(--status-warning)', amb: g })));
  for (const c of R.suspect.slice().sort((a, b) => R.post[b] - R.post[a])) if (!R._amb.has(c)) rows.push({ c, status: 'Suspect', color: 'var(--status-warning)' });
  let html = `<thead><tr><th>Component</th><th>Type</th><th>P(fault)</th><th class="num">Tests slow</th><th>Diagnosis</th><th>Recommended action</th><th>Status</th></tr></thead><tbody>`;
  for (const row of rows) {
    const comp = topo.comps[row.c];
    const dg = diagnose(R, row.c);
    html += `<tr data-c="${row.c}" class="${S.comp === row.c ? 'sel' : ''}">
      <td class="mono">${esc(comp.name.replace(topo.cluster + '-', ''))}</td>
      <td>${TYPE[comp.type]}</td>
      <td>${pbar(R.post[row.c], row.color)}</td>
      <td class="num">${R.nSlowComp[row.c]}/${R.nObsComp[row.c]}</td>
      <td class="wrap">${esc(row.amb ? `Either this or ${topo.comps[row.amb.comps.find(x => x !== row.c)].name.replace(topo.cluster + '-', '')}: at least one is faulty (${fmtP(row.amb.pAny)}), the tests so far cannot separate them` : dg.dx)}</td>
      <td class="wrap">${esc(row.amb ? 'Plan a pair that crosses only one of the two' : dg.action)}</td>
      <td><span class="pill"><span class="dot" style="background:${row.color}"></span>${row.status}</span></td></tr>`;
  }
  // masked groups
  const byBlocker = new Map();
  for (const m of R.masked) { if (!byBlocker.has(m.by)) byBlocker.set(m.by, []); byBlocker.get(m.by).push(m.comp); }
  for (const [by, list] of byBlocker) {
    html += `<tr data-c="${list[0]}"><td class="mono">${list.length} behind ${esc(topo.comps[by].name.replace(topo.cluster + '-', ''))}</td><td>${typeCounts(list).replace(/ · /g, ', ')}</td><td class="muted">n/a</td><td class="num muted">-</td>
      <td class="wrap">Every test through these also crossed this confirmed fault, so their own health is unknown</td><td class="wrap">Retest after the repair; the planner skips them until then</td>
      <td><span class="pill"><span class="dot" style="background:var(--accent)"></span>Masked</span></td></tr>`;
  }
  if (R.watch.length) {
    html += `<tr data-c="${R.watch[0]}"><td class="mono">${R.watch.length} on watch</td><td>${typeCounts(R.watch).replace(/ · /g, ', ')}</td><td class="muted">1–5%</td><td class="num muted">-</td>
      <td class="wrap">Mostly one transient slow result followed by clean retests</td><td class="wrap">Kept in rotation; retested when nodes are idle</td>
      <td><span class="pill"><span class="dot" style="background:#8a7a2a"></span>Watch</span></td></tr>`;
  }
  html += '</tbody>';
  $('findings').innerHTML = html;
  $('findings-meta').textContent = `After round ${R.round} · ${R.confirmed.length} confirmed · ${R.suspect.length} suspect · ${R.masked.length} masked · ${R.watch.length} watch`;
  $('findings').querySelectorAll('tbody tr').forEach(tr => tr.onclick = () => selectComp(+tr.dataset.c));
}

// ------------------------------------------------------------- chart
function renderChart(R) {
  const el = $('chart');
  const W = el.clientWidth || 640, H = 300, L = 36, Rr = 14, T = 12, B = 30;
  const ser = camp => [{ x: 0, y: 0, round: 0 }].concat(camp.rounds.map(r => ({ x: r.testsTotal, y: r.confirmed.length, round: r.round })));
  const a = ser(AD), b = ser(RD);
  const xMax = Math.ceil(Math.max(a.at(-1).x, b.at(-1).x) / 100) * 100;
  const yMax = Math.max(sc.faults.length, ...a.map(p => p.y), ...b.map(p => p.y)) + 1;
  const X = x => L + x / xMax * (W - L - Rr), Y = y => T + (1 - y / yMax) * (H - T - B);
  const step = pts => pts.map((p, k) => k === 0 ? `M${X(p.x)},${Y(p.y)}` : `H${X(p.x)}V${Y(p.y)}`).join('');
  let g = '<g class="grid">';
  for (let y = 0; y <= yMax; y++) g += `<line x1="${L}" x2="${W - Rr}" y1="${Y(y)}" y2="${Y(y)}"/>`;
  g += '</g><g class="axis">';
  for (let y = 0; y <= yMax; y++) g += `<text x="${L - 10}" y="${Y(y) + 4}" text-anchor="end">${y}</text>`;
  for (let x = 0; x <= xMax; x += 100) g += `<text x="${X(x)}" y="${H - 8}" text-anchor="middle">${x}</text>`;
  g += '</g>';
  const truthY = Y(sc.faults.length);
  const cp = a[S.round];
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}">${g}
    <line x1="${L}" x2="${W - Rr}" y1="${truthY}" y2="${truthY}" stroke="#636e6e" stroke-dasharray="4 4"/>
    <text x="${W - Rr}" y="${truthY - 6}" text-anchor="end" fill="#91999a" font-size="11.5">${sc.faults.length} faults in the simulated cluster</text>
    <path d="${step(b)}H${X(xMax)}" fill="none" stroke="#7d7cf4" stroke-width="2"/>
    <path d="${step(a)}" fill="none" stroke="#0de2f2" stroke-width="2"/>
    <line x1="${X(cp.x)}" x2="${X(cp.x)}" y1="${T}" y2="${H - B}" stroke="#eff0f0" opacity=".7"/>
    ${b.slice(1).map(p => `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="3" fill="#121213" stroke="#7d7cf4" stroke-width="1.5" data-s="r" data-k="${p.round}"/>`).join('')}
    ${a.slice(1).map(p => `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${p.round === S.round ? 4.5 : 3}" fill="${p.round === S.round ? '#0de2f2' : '#121213'}" stroke="#0de2f2" stroke-width="1.5" data-s="a" data-k="${p.round}"/>`).join('')}
  </svg>`;
  const tip = $('tip');
  el.querySelectorAll('circle').forEach(cn => {
    const camp = cn.dataset.s === 'a' ? AD : RD, r = camp.rounds[+cn.dataset.k - 1];
    cn.style.cursor = 'pointer';
    cn.onmouseenter = e => { tip.innerHTML = `<div>Round ${r.round} · ${r.testsTotal} pair tests</div><div class="${cn.dataset.s === 'a' ? 't-teal' : 't-violet'}">${cn.dataset.s === 'a' ? 'Planned pairs' : 'Random pairs'}: ${r.confirmed.length} confirmed</div>`; tip.style.opacity = 1; moveTip(e); };
    cn.onmousemove = moveTip;
    cn.onmouseleave = () => { tip.style.opacity = 0; };
    if (cn.dataset.s === 'a') cn.onclick = () => { S.round = r.round; render(); };
  });
  const allA = AD.rounds.find(r => r.confirmed.length >= sc.faults.length && r.score.fp === 0);
  const lastB = RD.rounds.at(-1);
  $('chart-note').textContent = `Same Bayesian model on both lines; only the choice of pairs differs. Planned pairs confirmed ${allA ? `all ${sc.faults.length} after ${allA.testsTotal} tests` : `${AD.rounds.at(-1).confirmed.length}`}; random shakedown pairs had ${lastB.confirmed.length} after ${lastB.testsTotal}.`;
}

// ------------------------------------------------------------- test log
function renderLog(R) {
  $('log-round').textContent = `· round ${R.round}`;
  const rows = R.tests.map(t => {
    const res = R.newObs.filter(o => o.i === t.i && o.j === t.j);
    const slow = res.filter(o => o.x < F.MODEL.slowThr);
    const min = Math.min(...res.map(o => o.x));
    const id = 'fabric-ibperf-' + F.hashSeed(sc.seed, R.round, t.i, t.j).toString(36).slice(0, 5);
    return { t, slow, min, id };
  }).sort((a, b) => b.slow.length - a.slow.length || a.min - b.min);
  $('log').innerHTML = `<thead><tr><th>Test ID</th><th>Hostnames</th><th>Type</th><th class="num">Min Gb/s</th><th>Status</th></tr></thead><tbody>` +
    rows.map(r => `<tr data-n="${r.t.i},${r.t.j}"><td class="mono">${r.id}</td><td class="mono">${topo.nodes[r.t.i].name.replace(topo.cluster + '-', '')}, ${topo.nodes[r.t.j].name.replace(topo.cluster + '-', '')}</td><td>Planned</td><td class="num">${gbps(r.min)}</td>
      <td>${r.slow.length ? `<span class="status fail"><i data-lucide="circle-x"></i>Slow: ${r.slow.map(o => 'rdma' + o.r).join(', ')}</span>` : `<span class="status pass"><i data-lucide="circle-check"></i>Passed</span>`}</td></tr>`).join('') + '</tbody>';
  $('log').querySelectorAll('tbody tr').forEach(tr => {
    const [i, j] = tr.dataset.n.split(',').map(Number);
    tr.onmouseenter = () => { S.hlNodes = [i, j]; renderMap(R); };
    tr.onmouseleave = () => { S.hlNodes = []; renderMap(R); };
  });
}

window.addEventListener('resize', () => { if (AD && S.round) renderChart(cur()); });
main().catch(err => { $('loading-text').textContent = 'Failed to load: ' + err.message; console.error(err); });
