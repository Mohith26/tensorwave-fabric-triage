import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as F from '../src/fabric.js';
import { generateScenario } from '../scripts/generate.mjs';

const committed = JSON.parse(fs.readFileSync(new URL('../data/scenario.json', import.meta.url)));

function obsFor(topo, sc, pairs, round = 1) {
  const s = F.indexScenario(sc);
  const out = [];
  for (const [i, j] of pairs) for (let r = 0; r < topo.rails; r++) out.push({ round, i, j, r, x: F.simulateObservation(topo, s, i, j, r, round) });
  return out;
}

test('generator is deterministic and matches committed data', () => {
  assert.deepEqual(generateScenario(20261110), committed);
  assert.deepEqual(generateScenario(5), generateScenario(5));
});

test('Gibbs marginals match exact enumeration on a tiny fabric', () => {
  const topo = F.buildTopology({ pods: ['a', 'b'], nodesPerPod: 2, rails: 1 });
  assert.equal(topo.comps.length, 8);
  const sc = { seed: 3, faults: [{ comp: topo.nicId(1, 0), severity: 0.6, intermittency: 1 }], busy: [] };
  const pairs = [[0, 1], [2, 3], [0, 2], [1, 3], [0, 3], [1, 2]];
  let obs = [];
  for (let round = 1; round <= 2; round++) obs = obs.concat(obsFor(topo, sc, pairs, round));
  const exact = F.exactPosterior(topo, obs);
  const inf = F.infer(topo, obs, { sweeps: 4000, burn: 400, chains: 4, seed: 9 });
  for (let c = 0; c < topo.comps.length; c++) assert.ok(Math.abs(exact[c] - inf.post[c]) < 0.02, `comp ${c}: exact ${exact[c]} vs gibbs ${inf.post[c]}`);
  assert.ok(exact[topo.nicId(1, 0)] > 0.98);
});

test('a bad leaf switch is explained away: leaf confirmed, no NIC in that pod blamed', () => {
  const topo = F.buildTopology({ pods: ['a', 'b', 'c'], nodesPerPod: 8, rails: 2 });
  const sc = { seed: 11, faults: [{ comp: topo.leafId(1, 1), severity: 0.7, intermittency: 1 }], busy: [] };
  const pairs = [];
  for (let k = 0; k < 8; k++) { pairs.push([k, 8 + k]); pairs.push([8 + k, 16 + ((k + 3) % 8)]); }
  pairs.push([8, 9], [10, 11], [12, 13]);
  const obs = obsFor(topo, sc, pairs);
  const inf = F.infer(topo, obs, { seed: 1 });
  const cls = F.classify(topo, inf);
  assert.ok(cls.confirmed.includes(topo.leafId(1, 1)));
  assert.equal(cls.confirmed.filter(c => topo.comps[c].type === 'nic').length, 0);
  // the threshold-vote baseline blames every node behind that leaf
  const vote = F.voteHeuristic(topo, obs);
  assert.ok(vote.nodes.filter(n => topo.nodes[n].pod === 1).length >= 6);
});

test('spine uplink vs leaf: intra-pod tests clear the leaf and confirm the uplink', () => {
  const topo = F.buildTopology({ pods: ['a', 'b', 'c'], nodesPerPod: 8, rails: 2 });
  const sc = { seed: 12, faults: [{ comp: topo.upId(0, 0), severity: 0.75, intermittency: 1 }], busy: [] };
  const pairs = [];
  for (let k = 0; k < 8; k++) { pairs.push([k, 8 + k]); pairs.push([k, 16 + k]); }
  pairs.push([0, 1], [2, 3], [4, 5], [6, 7]);
  const inf = F.infer(topo, obsFor(topo, sc, pairs), { seed: 2 });
  assert.ok(inf.post[topo.upId(0, 0)] > 0.98, `uplink ${inf.post[topo.upId(0, 0)]}`);
  assert.ok(inf.post[topo.leafId(0, 0)] < 0.05, `leaf ${inf.post[topo.leafId(0, 0)]}`);
});

test('components behind a confirmed fault are reported as masked, not cleared', () => {
  const topo = F.buildTopology({ pods: ['a', 'b'], nodesPerPod: 6, rails: 1 });
  const sc = { seed: 13, faults: [{ comp: topo.leafId(0, 0), severity: 0.7, intermittency: 1 }], busy: [] };
  const pairs = [[0, 6], [1, 7], [2, 8], [3, 9], [4, 10], [5, 11], [0, 1], [2, 3], [6, 7], [8, 9]];
  const inf = F.infer(topo, obsFor(topo, sc, pairs), { seed: 3 });
  const cls = F.classify(topo, inf);
  const maskedComps = cls.masked.map(m => m.comp);
  for (let n = 0; n < 6; n++) assert.ok(maskedComps.includes(topo.nicId(n, 0)), `node ${n} should be masked`);
  assert.ok(maskedComps.includes(topo.upId(0, 0)));
  assert.ok(cls.masked.every(m => m.by === topo.leafId(0, 0)));
});

test('planner: suspect paired with a cleared node beats two cleared nodes; matching is valid', () => {
  const topo = F.buildTopology({ pods: ['a', 'b'], nodesPerPod: 8, rails: 2 });
  const sc = { seed: 14, faults: [{ comp: topo.nicId(3, 1), severity: 0.6, intermittency: 1 }], busy: [] };
  const pairs = [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11], [12, 13], [14, 15], [0, 8], [1, 9], [4, 12], [5, 13]];
  const inf = F.infer(topo, obsFor(topo, sc, pairs), { seed: 4 });
  const ctx = F.planningContext(topo, inf);
  const gSuspect = F.pairInfoGain(topo, inf, 3, 0, ctx);
  const gCleared = F.pairInfoGain(topo, inf, 0, 1, ctx);
  assert.ok(gSuspect > 5 * gCleared, `${gSuspect} vs ${gCleared}`);
  const idle = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const plan = F.planRound(topo, inf, idle, { seed: 1, round: 2 });
  const seen = new Set();
  for (const t of plan) { assert.ok(idle.includes(t.i) && idle.includes(t.j)); assert.ok(!seen.has(t.i) && !seen.has(t.j)); seen.add(t.i); seen.add(t.j); }
  assert.ok(plan.some(t => t.i === 3 || t.j === 3), 'suspect node 3 gets retested');
  assert.ok(plan.every((t, k) => k === 0 || plan[k - 1].bits >= t.bits));
});

test('committed scenario: adaptive confirms all 7 faults, no false blame, fewer tests than random pairings', () => {
  const topo = F.buildTopology(committed);
  const ad = F.runCampaign(topo, committed, { strategy: 'adaptive', stopWhenResolved: false, maxRounds: 8 });
  const rd = F.runCampaign(topo, committed, { strategy: 'random', stopWhenResolved: false, maxRounds: 8 });
  const a = ad.rounds.at(-1), r = rd.rounds.at(-1);
  assert.equal(a.score.tp, committed.faults.length);
  assert.equal(a.score.fp, 0);
  assert.equal(a.score.healthyBlamed, 0);
  assert.ok(a.testsTotal < 0.6 * r.testsTotal, `${a.testsTotal} vs ${r.testsTotal}`);
  assert.ok(r.voteScore.healthyBlamed > 30, 'vote heuristic blames nodes behind the bad leaf/uplink');
  // every node that was ever idle got tested
  assert.equal(a.untestedNic, 0);
});

test('no false confirmations across seeded small clusters', () => {
  let fp = 0, tp = 0, total = 0, explained = 0;
  for (let s = 1; s <= 6; s++) {
    const sc = generateScenario(500 + s, { pods: ['p1', 'p2', 'p3'], nodesPerPod: 10, rails: 4, nNic: 3, nFlaky: 0, nLeaf: 1, nUp: 1, maxRounds: 6 });
    const topo = F.buildTopology(sc);
    const res = F.runCampaign(topo, sc, { strategy: 'adaptive', stopWhenResolved: false, maxRounds: 6 });
    const last = res.rounds.at(-1);
    fp += last.score.fp; tp += last.score.tp; total += sc.faults.length;
    // faults not confirmed must be honestly reported: masked behind another fault or in an either/or group
    const conf = new Set(last.confirmed), masked = new Set(last.masked.map(m => m.comp));
    const amb = new Set(last.ambiguous.flatMap(g => g.comps));
    for (const f of sc.faults) if (!conf.has(f.comp) && (masked.has(f.comp) || amb.has(f.comp))) explained++;
  }
  assert.equal(fp, 0);
  assert.ok(tp + explained >= total - 1, `${tp} confirmed + ${explained} masked/ambiguous of ${total}`);
});
