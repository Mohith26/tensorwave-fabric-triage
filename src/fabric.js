// Fabric Triage core: Bayesian fault localization for rail-optimized GPU fabrics,
// plus information-gain planning of the next round of pairwise ib_write_bw tests.
// Pure ES module, no dependencies; runs in the browser and under `node --test`.

// ---------------------------------------------------------------- RNG helpers
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(...parts) {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= 0x9e3779b9;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function randn(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------- topology
// Rail-optimized fabric: GPU k of every node uses NIC rdma<k>, which plugs into the
// pod's leaf switch for rail k. Leaves reach other pods through spine plane k.
// Fault-able components: NIC rail (node, rail), leaf (pod, rail), leaf->spine uplinks (pod, rail).
export function buildTopology({ pods, nodesPerPod, rails, cluster = 'tus1' }) {
  const P = pods.length;
  const nodes = [];
  pods.forEach((pod, p) => {
    for (let g = 1; g <= nodesPerPod; g++) nodes.push({ id: nodes.length, pod: p, g, name: `${cluster}-${pod}-g${g}` });
  });
  const N = nodes.length;
  const comps = [];
  for (let n = 0; n < N; n++) for (let r = 0; r < rails; r++) {
    comps.push({ id: comps.length, type: 'nic', node: n, pod: nodes[n].pod, rail: r, name: `${nodes[n].name} · rdma${r}` });
  }
  const leafBase = comps.length;
  for (let p = 0; p < P; p++) for (let r = 0; r < rails; r++) {
    comps.push({ id: comps.length, type: 'leaf', pod: p, rail: r, name: `${cluster}-${pods[p]} leaf · rail ${r}` });
  }
  const upBase = comps.length;
  for (let p = 0; p < P; p++) for (let r = 0; r < rails; r++) {
    comps.push({ id: comps.length, type: 'uplink', pod: p, rail: r, name: `${cluster}-${pods[p]} leaf → spine plane ${r}` });
  }
  const nicId = (n, r) => n * rails + r;
  const leafId = (p, r) => leafBase + p * rails + r;
  const upId = (p, r) => upBase + p * rails + r;
  function pathComps(i, j, r) {
    const pi = nodes[i].pod, pj = nodes[j].pod;
    if (pi === pj) return [nicId(i, r), nicId(j, r), leafId(pi, r)];
    return [nicId(i, r), nicId(j, r), leafId(pi, r), leafId(pj, r), upId(pi, r), upId(pj, r)];
  }
  return { cluster, pods, P, nodesPerPod, rails, nodes, N, comps, nicId, leafId, upId, pathComps, leafBase, upBase };
}

// ---------------------------------------------------------------- measurement model
// x = measured ib_write_bw / line rate. Healthy paths sit near 0.982 with small noise,
// plus occasional transient dips (congestion from neighbours, a slow first iteration).
// Each component is in one of three states: 0 healthy, 1 solid fault (degrades almost every
// test through it), 2 flapping fault (degrades about half of them). A path shows degraded
// bandwidth anywhere in [dLo, dHi] if any faulty component on it fires.
export const MODEL = {
  mu: 0.982, sd: 0.013, eps: 0.03, tLo: 0.55, tHi: 0.98,
  dLo: 0.22, dHi: 0.95, floor: 1e-3, slowThr: 0.93,
  q: [0, 0.97, 0.5],
  prior: { nic: [0.003, 0.003], leaf: [0.006, 0.004], uplink: [0.006, 0.004] },
};

function normpdf(x, mu, sd) {
  const z = (x - mu) / sd;
  return Math.exp(-0.5 * z * z) / (sd * Math.sqrt(2 * Math.PI));
}
function normcdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
export function fHealthy(x, m = MODEL) {
  const t = x >= m.tLo && x <= m.tHi ? 1 / (m.tHi - m.tLo) : 0;
  return (1 - m.eps) * normpdf(x, m.mu, m.sd) + m.eps * t + m.floor;
}
export function fDegraded(x, m = MODEL) {
  return (x >= m.dLo && x <= m.dHi ? 1 / (m.dHi - m.dLo) : 0) + m.floor;
}
// P(slow | healthy path), P(slow | degraded path) for the binary planner outcome.
export function slowProbs(m = MODEL) {
  const tr = Math.max(0, Math.min(m.slowThr, m.tHi) - m.tLo) / (m.tHi - m.tLo);
  const ph = (1 - m.eps) * normcdf((m.slowThr - m.mu) / m.sd) + m.eps * tr;
  const pd = Math.max(0, Math.min(m.slowThr, m.dHi) - m.dLo) / (m.dHi - m.dLo);
  return { ph, pd };
}
// prior over states [healthy, solid, flapping]
export function statePrior(comp, m = MODEL) {
  const [a, b] = m.prior[comp.type];
  return [1 - a - b, a, b];
}
export function priorOf(comp, m = MODEL) { const p = statePrior(comp, m); return p[1] + p[2]; }
export function logSurvive(m = MODEL) { return m.q.map(q => Math.log(1 - q)); }

// ---------------------------------------------------------------- scenario + simulator
// Ground truth lives only in the scenario; inference never reads it.
export function simulateObservation(topo, scenario, i, j, r, round) {
  const rng = mulberry32(hashSeed(scenario.seed, 'obs', round, Math.min(i, j), Math.max(i, j), r));
  const path = topo.pathComps(i, j, r);
  let cap = 1;
  for (const c of path) {
    const f = scenario.faultByComp[c];
    if (f && rng() < f.intermittency) cap = Math.min(cap, f.severity);
  }
  let x = cap * 0.982 + randn(rng) * 0.011;
  if (rng() < 0.03) x *= 0.6 + 0.37 * rng(); // transient dip on any path
  return Math.max(0.02, Math.min(1.02, x));
}

export function indexScenario(scenario) {
  const faultByComp = {};
  for (const f of scenario.faults) faultByComp[f.comp] = f;
  return { ...scenario, faultByComp };
}

// ---------------------------------------------------------------- inference
// Gibbs sampling over 3-state component variables with Rao-Blackwellized marginals.
// L(obs | path) = (1 - S) fD(x) + S fH(x), S = prod over faulty comps on path of (1 - q_state).
export function infer(topo, obs, opts = {}) {
  const m = opts.model || MODEL;
  const sweeps = opts.sweeps ?? 700, burn = opts.burn ?? 150, chains = opts.chains ?? 2, thin = opts.thin ?? 3;
  const keepSamples = opts.keepSamples ?? 100;
  const C = topo.comps.length;
  const O = obs.length;
  const paths = obs.map(o => topo.pathComps(o.i, o.j, o.r));
  const compObs = Array.from({ length: C }, () => []);
  paths.forEach((p, o) => p.forEach(c => compObs[c].push(o)));
  const touched = [];
  for (let c = 0; c < C; c++) if (compObs[c].length) touched.push(c);
  const logPri = topo.comps.map(c => statePrior(c, m).map(Math.log));
  const post = new Float64Array(C);
  const postFlaky = new Float64Array(C);
  for (let c = 0; c < C; c++) { const sp = statePrior(topo.comps[c], m); post[c] = sp[1] + sp[2]; postFlaky[c] = sp[2]; }
  // per-observation log-likelihood table indexed by (#solid faults, #flapping faults) on its path
  const K = 7, KK = K * K;
  const ls = logSurvive(m);
  const tab = new Float64Array(O * KK);
  for (let o = 0; o < O; o++) {
    const fh = fHealthy(obs[o].x, m), fd = fDegraded(obs[o].x, m);
    for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) {
      const S = Math.exp(a * ls[1] + b * ls[2]);
      tab[o * KK + a * K + b] = Math.log((1 - S) * fd + S * fh);
    }
  }
  const acc = new Float64Array(C), accF = new Float64Array(C);
  let kept = 0;
  const samples = [];
  const totalKeep = chains * Math.floor((sweeps - burn) / thin);
  const sampleEvery = Math.max(1, Math.floor(totalKeep / keepSamples));
  let keepCounter = 0;
  for (let ch = 0; ch < chains; ch++) {
    const rng = mulberry32(hashSeed(opts.seed ?? 1, 'gibbs', ch, O));
    const z = new Uint8Array(C);
    const idx = new Int32Array(O); // a*K + b for each observation
    const order = touched.slice();
    for (let s = 0; s < sweeps; s++) {
      for (let a = order.length - 1; a > 0; a--) { const b = Math.floor(rng() * (a + 1)); const t = order[a]; order[a] = order[b]; order[b] = t; }
      const record = s >= burn && (s - burn) % thin === 0;
      for (let q = 0; q < order.length; q++) {
        const c = order[q];
        const list = compObs[c];
        const zc = z[c];
        const off = zc === 1 ? K : zc === 2 ? 1 : 0; // remove current state's contribution
        let l0 = logPri[c][0], l1 = logPri[c][1], l2 = logPri[c][2];
        for (let t = 0; t < list.length; t++) {
          const o = list[t];
          const base = o * KK + idx[o] - off;
          l0 += tab[base]; l1 += tab[base + K]; l2 += tab[base + 1];
        }
        const mx = l0 > l1 ? (l0 > l2 ? l0 : l2) : (l1 > l2 ? l1 : l2);
        const e0 = Math.exp(l0 - mx), e1 = Math.exp(l1 - mx), e2 = Math.exp(l2 - mx);
        const tot = e0 + e1 + e2;
        const p0 = e0 / tot, p1 = e1 / tot;
        if (record) { acc[c] += 1 - p0; accF[c] += e2 / tot; }
        const u = rng();
        const nz = u < p0 ? 0 : u < p0 + p1 ? 1 : 2;
        if (nz !== zc) {
          const d = (nz === 1 ? K : nz === 2 ? 1 : 0) - off;
          for (let t = 0; t < list.length; t++) idx[list[t]] += d;
          z[c] = nz;
        }
      }
      if (record) {
        kept++;
        if (keepCounter++ % sampleEvery === 0 && samples.length < keepSamples) samples.push(z.slice());
      }
    }
  }
  for (const c of touched) { post[c] = acc[c] / kept; postFlaky[c] = accF[c] / kept; }
  const nObs = new Int32Array(C), nSlow = new Int32Array(C);
  for (let o = 0; o < O; o++) for (const c of paths[o]) { nObs[c]++; if (obs[o].x < m.slowThr) nSlow[c]++; }
  return { post, postFlaky, samples, touched, nObs, nSlow, compObs, paths };
}

// Exact posterior P(faulty) by enumeration over 3^C states (tests on tiny topologies).
export function exactPosterior(topo, obs, m = MODEL) {
  const C = topo.comps.length;
  if (C > 11) throw new Error('too many components for enumeration');
  const ls = logSurvive(m);
  const paths = obs.map(o => topo.pathComps(o.i, o.j, o.r));
  const fh = obs.map(o => fHealthy(o.x, m)), fd = obs.map(o => fDegraded(o.x, m));
  const pri = topo.comps.map(c => statePrior(c, m));
  const marg = new Float64Array(C);
  const z = new Uint8Array(C);
  let Z = 0;
  const total = Math.pow(3, C);
  for (let idx = 0; idx < total; idx++) {
    let v = idx;
    for (let c = 0; c < C; c++) { z[c] = v % 3; v = Math.floor(v / 3); }
    let lpv = 0;
    for (let c = 0; c < C; c++) lpv += Math.log(pri[c][z[c]]);
    for (let o = 0; o < obs.length; o++) {
      let l = 0;
      for (const c of paths[o]) l += ls[z[c]];
      const S = Math.exp(l);
      lpv += Math.log((1 - S) * fd[o] + S * fh[o]);
    }
    const w = Math.exp(lpv);
    Z += w;
    for (let c = 0; c < C; c++) if (z[c]) marg[c] += w;
  }
  for (let c = 0; c < C; c++) marg[c] /= Z;
  return marg;
}

// A component is masked when every test through it also crossed a confirmed fault:
// its own health cannot be judged until that fault is repaired.
export function maskedBy(inf, c, confirmedSet) {
  const list = inf.compObs[c];
  if (!list.length) return null;
  let blocker = null;
  for (const o of list) {
    const hit = inf.paths[o].find(d => d !== c && confirmedSet.has(d));
    if (hit === undefined) return null;
    blocker = blocker ?? hit;
  }
  return blocker;
}

// ---------------------------------------------------------------- planning
function hb(p) { return p <= 0 || p >= 1 ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p)); }

export function planningContext(topo, inf, m = MODEL) {
  const { ph, pd } = slowProbs(m);
  const isTouched = new Uint8Array(topo.comps.length);
  for (const c of inf.touched) isTouched[c] = 1;
  const ls = logSurvive(m);
  const K = 7;
  const P = new Float64Array(K * K), H = new Float64Array(K * K);
  for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) {
    const S = Math.exp(a * ls[1] + b * ls[2]);
    const p = (1 - S) * pd + S * ph;
    P[a * K + b] = p; H[a * K + b] = hb(p);
  }
  // per-sample code (a*K+b contribution) for every component
  const S = inf.samples.length;
  const code = inf.samples.map(z => { const v = new Uint8Array(z.length); for (let c = 0; c < z.length; c++) v[c] = z[c] === 1 ? K : z[c] === 2 ? 1 : 0; return v; });
  return { ph, pd, isTouched, m, K, P, H, S, code };
}

// Expected information (bits) about component states from testing pair (i, j) on all rails.
export function pairInfoGain(topo, inf, i, j, ctx) {
  const { isTouched, m, K, P, H, S, code } = ctx;
  let bits = 0;
  for (let r = 0; r < topo.rails; r++) {
    const path = topo.pathComps(i, j, r);
    // untouched components are independent of the data: mixture over their states
    let D = [[1, 0]]; // [prob, code offset]
    const tc = [];
    for (const c of path) {
      if (isTouched[c]) { tc.push(c); continue; }
      const sp = statePrior(topo.comps[c], m);
      const nd = [];
      for (const [w, k] of D) {
        nd.push([w * sp[0], k]);
        if (w * sp[1] > 1e-7) nd.push([w * sp[1], k + K]);
        if (w * sp[2] > 1e-7) nd.push([w * sp[2], k + 1]);
      }
      D = nd;
    }
    let pMean = 0, ce = 0;
    const nS = Math.max(1, S);
    for (let s = 0; s < nS; s++) {
      let k0 = 0;
      if (S) { const v = code[s]; for (let t = 0; t < tc.length; t++) k0 += v[tc[t]]; }
      for (let d = 0; d < D.length; d++) { const w = D[d][0], k = k0 + D[d][1]; pMean += w * P[k]; ce += w * H[k]; }
    }
    pMean /= nS; ce /= nS;
    bits += hb(pMean) - ce;
  }
  return bits;
}

// Greedy max-weight matching on expected information gain among idle nodes.
export function planRound(topo, inf, idle, opts = {}) {
  const minBits = opts.minBits ?? 0.05;
  const rng = mulberry32(hashSeed(opts.seed ?? 7, 'plan', opts.round ?? 0));
  const ctx = planningContext(topo, inf, opts.model || MODEL);
  const edges = [];
  for (let a = 0; a < idle.length; a++) for (let b = a + 1; b < idle.length; b++) {
    const i = idle[a], j = idle[b];
    const g = pairInfoGain(topo, inf, i, j, ctx);
    edges.push({ i, j, bits: g, key: g * (1 + 1e-6 * rng()) });
  }
  edges.sort((x, y) => y.key - x.key);
  const used = new Uint8Array(topo.N);
  const tests = [];
  for (const e of edges) {
    if (e.bits < minBits) break;
    if (used[e.i] || used[e.j]) continue;
    used[e.i] = used[e.j] = 1;
    tests.push({ i: e.i, j: e.j, bits: e.bits });
  }
  return tests;
}

export function randomMatching(topo, idle, seed, round) {
  const rng = mulberry32(hashSeed(seed, 'random-matching', round));
  const a = idle.slice();
  for (let k = a.length - 1; k > 0; k--) { const b = Math.floor(rng() * (k + 1)); const t = a[k]; a[k] = a[b]; a[b] = t; }
  const tests = [];
  for (let k = 0; k + 1 < a.length; k += 2) tests.push({ i: a[k], j: a[k + 1], bits: null });
  return tests;
}

// ---------------------------------------------------------------- decisions + baselines
// confirmed >= CONFIRM; suspect in [SUSPECT, CONFIRM); watch in (CLEAR, SUSPECT); cleared <= CLEAR
export const CONFIRM = 0.98, SUSPECT = 0.05, CLEAR = 0.01;

export function classify(topo, inf) {
  const confirmed = [], suspect = [], watch = [], masked = [];
  let untestedNic = 0;
  for (const c of topo.comps) {
    if (inf.nObs[c.id] === 0) { if (c.type === 'nic') untestedNic++; continue; }
    if (inf.post[c.id] >= CONFIRM) confirmed.push(c.id);
  }
  const confSet = new Set(confirmed);
  for (const c of topo.comps) {
    if (inf.nObs[c.id] === 0 || confSet.has(c.id)) continue;
    const p = inf.post[c.id];
    const blk = maskedBy(inf, c.id, confSet);
    if (blk !== null) { masked.push({ comp: c.id, by: blk }); continue; }
    if (p >= SUSPECT) suspect.push(c.id);
    else if (p > CLEAR) watch.push(c.id);
  }
  return { confirmed, suspect, watch, masked, untestedNic, resolved: suspect.length === 0 && untestedNic === 0 };
}

// Either/or groups: suspects that the data cannot tell apart, but where at least one must be faulty
// (e.g. two spine uplinks only ever tested against each other). Estimated from posterior samples.
export function ambiguityGroups(topo, inf, suspects, opts = {}) {
  const minEach = opts.minEach ?? 0.2, minAny = opts.minAny ?? 0.95;
  const cand = suspects.filter(c => inf.post[c] >= minEach);
  const S = inf.samples.length;
  const groups = [];
  const used = new Set();
  for (let a = 0; a < cand.length; a++) for (let b = a + 1; b < cand.length; b++) {
    const A = cand[a], B = cand[b];
    if (used.has(A) || used.has(B) || !S) continue;
    let any = 0;
    for (const z of inf.samples) if (z[A] || z[B]) any++;
    if (any / S >= minAny) { groups.push({ comps: [A, B], pAny: any / S }); used.add(A); used.add(B); }
  }
  return groups;
}

// What a threshold-and-vote shakedown does: a NIC rail with >= minSlow slow pair tests is blamed.
export function voteHeuristic(topo, obs, opts = {}) {
  const thr = opts.slowThr ?? MODEL.slowThr, minSlow = opts.minSlow ?? 2;
  const slow = new Int32Array(topo.N * topo.rails), tot = new Int32Array(topo.N * topo.rails);
  for (const o of obs) {
    for (const n of [o.i, o.j]) { tot[n * topo.rails + o.r]++; if (o.x < thr) slow[n * topo.rails + o.r]++; }
  }
  const flagged = [];
  for (let k = 0; k < slow.length; k++) if (slow[k] >= minSlow && slow[k] * 2 >= tot[k]) flagged.push(k);
  const nodes = [...new Set(flagged.map(k => Math.floor(k / topo.rails)))];
  return { flagged, nodes };
}

// Ground-truth scoring (for validation only).
export function score(topo, scenario, confirmedComps, blamedNodes) {
  const truth = new Set(scenario.faults.map(f => f.comp));
  const conf = new Set(confirmedComps);
  const tp = [...truth].filter(c => conf.has(c)).length;
  const fp = [...conf].filter(c => !truth.has(c)).length;
  const faultyNodes = new Set(scenario.faults.filter(f => topo.comps[f.comp].type === 'nic').map(f => topo.comps[f.comp].node));
  const healthyBlamed = blamedNodes.filter(n => !faultyNodes.has(n)).length;
  return { tp, fp, fn: truth.size - tp, healthyBlamed, faultyNodes: faultyNodes.size };
}

// ---------------------------------------------------------------- campaign runner
export function idleNodes(topo, scenario, round) {
  const busy = new Set(scenario.busy[round - 1] || []);
  const out = [];
  for (let n = 0; n < topo.N; n++) if (!busy.has(n)) out.push(n);
  return out;
}

// Stepwise campaign so a UI can render between rounds.
export function createCampaign(topo, scenarioRaw, opts = {}) {
  const scenario = scenarioRaw.faultByComp ? scenarioRaw : indexScenario(scenarioRaw);
  const strategy = opts.strategy || 'adaptive';
  const maxRounds = opts.maxRounds ?? 8;
  const inferOpts = { seed: scenario.seed, ...(opts.inferOpts || {}) };
  const state = { strategy, rounds: [], obs: [], done: false };
  let inf = infer(topo, [], inferOpts);
  let testsTotal = 0;
  state.step = function () {
    if (state.done) return null;
    const round = state.rounds.length + 1;
    const idle = idleNodes(topo, scenario, round);
    const tests = strategy === 'adaptive'
      ? planRound(topo, inf, idle, { seed: scenario.seed, round, minBits: opts.minBits })
      : randomMatching(topo, idle, scenario.seed, round);
    if (tests.length === 0) { state.done = true; return null; }
    const newObs = [];
    for (const t of tests) for (let r = 0; r < topo.rails; r++) {
      newObs.push({ round, i: t.i, j: t.j, r, x: simulateObservation(topo, scenario, t.i, t.j, r, round) });
    }
    state.obs = state.obs.concat(newObs);
    testsTotal += tests.length;
    inf = infer(topo, state.obs, { ...inferOpts, seed: hashSeed(scenario.seed, round) });
    const cls = classify(topo, inf);
    const blamed = [...new Set(cls.confirmed.filter(c => topo.comps[c].type === 'nic').map(c => topo.comps[c].node))];
    const vote = voteHeuristic(topo, state.obs);
    const ambiguous = ambiguityGroups(topo, inf, cls.suspect);
    const rec = {
      round, tests, idle, idleCount: idle.length, testsTotal, nObs: state.obs.length, newObs,
      post: inf.post, postFlaky: inf.postFlaky, nObsComp: inf.nObs, nSlowComp: inf.nSlow,
      confirmed: cls.confirmed, suspect: cls.suspect, watch: cls.watch, masked: cls.masked, ambiguous,
      untestedNic: cls.untestedNic, resolved: cls.resolved,
      blamedNodes: blamed, vote,
      score: score(topo, scenario, cls.confirmed, blamed),
      voteScore: score(topo, scenario, vote.flagged, vote.nodes),
      inf,
    };
    state.rounds.push(rec);
    if ((cls.resolved && opts.stopWhenResolved !== false) || round >= maxRounds) state.done = true;
    return rec;
  };
  state.next = function (idleOverride) {
    // the plan for the round after the latest one (shown as "Next round" in the UI)
    const round = state.rounds.length + 1;
    const idle = idleOverride || idleNodes(topo, scenario, round);
    return strategy === 'adaptive' ? planRound(topo, inf, idle, { seed: scenario.seed, round, minBits: opts.minBits }) : randomMatching(topo, idle, scenario.seed, round);
  };
  return state;
}

export function runCampaign(topo, scenarioRaw, opts = {}) {
  const c = createCampaign(topo, scenarioRaw, opts);
  while (!c.done) c.step();
  return { strategy: c.strategy, rounds: c.rounds, obs: c.obs };
}

// Robust per-component bandwidth summary for the findings table.
export function evidenceFor(topo, inf, obs, c) {
  const xs = inf.compObs[c].map(o => obs[o].x);
  const slow = xs.filter(x => x < MODEL.slowThr).sort((a, b) => a - b);
  const med = slow.length ? slow[Math.floor(slow.length / 2)] : null;
  return { n: xs.length, slow: slow.length, medianSlowGbps: med == null ? null : med * 400 };
}
