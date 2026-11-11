// Prints every headline number used on the page and in the README.
// node scripts/report.mjs            -> committed scenario
// node scripts/report.mjs --seeds 20 -> also a multi-seed robustness + calibration sweep
import fs from 'fs';
import * as F from '../src/fabric.js';
import { generateScenario } from './generate.mjs';

const sc = JSON.parse(fs.readFileSync(new URL('../data/scenario.json', import.meta.url)));
const topo = F.buildTopology(sc);

function summarize(sc, topo, label) {
  const ad = F.runCampaign(topo, sc, { strategy: 'adaptive', stopWhenResolved: false, maxRounds: 8 });
  const rd = F.runCampaign(topo, sc, { strategy: 'random', stopWhenResolved: false, maxRounds: 8 });
  const a = ad.rounds.at(-1), r = rd.rounds.at(-1);
  const firstAll = ad.rounds.find(x => x.score.tp === sc.faults.length);
  if (label) {
    console.log(`== ${label}`);
    console.log('faults:', sc.faults.map(f => `${topo.comps[f.comp].name} (${f.kind}, ${(f.severity * 100).toFixed(0)}%)`).join('; '));
    for (const x of ad.rounds) console.log(`adaptive r${x.round}: tests ${x.tests.length} (cum ${x.testsTotal}), confirmed ${x.confirmed.length} (tp ${x.score.tp}, fp ${x.score.fp}), suspects ${x.suspect.length}, watch ${x.watch.length}, masked ${x.masked.length}, untested NIC rails ${x.untestedNic}, healthy nodes blamed ${x.score.healthyBlamed}`);
    for (const x of rd.rounds) console.log(`random   r${x.round}: tests ${x.tests.length} (cum ${x.testsTotal}), confirmed ${x.confirmed.length} (tp ${x.score.tp}, fp ${x.score.fp}), vote: flagged rails ${x.vote.flagged.length}, nodes ${x.vote.nodes.length}, healthy nodes blamed ${x.voteScore.healthyBlamed}`);
    console.log(`all faults confirmed (adaptive): round ${firstAll ? firstAll.round : 'never'}, cumulative tests ${firstAll ? firstAll.testsTotal : '-'}`);
    console.log(`masked at end: ${a.masked.map(mk => `${topo.comps[mk.comp].name} by ${topo.comps[mk.by].name}`).join('; ') || 'none'}`);
  }
  return { a, r, firstAll };
}

summarize(sc, topo, `committed scenario seed ${sc.seed}`);

const k = process.argv.indexOf('--seeds');
if (k > 0) {
  const n = +process.argv[k + 1];
  const agg = { adTp: 0, adFp: 0, adTests: 0, adBlamed: 0, rdTp: 0, rdFp: 0, rdTests: 0, voteBlamed: 0, voteNicTp: 0, total: 0, nicTotal: 0, allFound: 0 };
  const bins = Array.from({ length: 10 }, () => ({ n: 0, sumP: 0, pos: 0 }));
  for (let s = 1; s <= n; s++) {
    const scn = generateScenario(1000 + s);
    const tp = F.buildTopology(scn);
    const { a, r, firstAll } = summarize(scn, tp, null);
    agg.adTp += a.score.tp; agg.adFp += a.score.fp; agg.adTests += a.testsTotal; agg.adBlamed += a.score.healthyBlamed;
    agg.rdTp += r.score.tp; agg.rdFp += r.score.fp; agg.rdTests += r.testsTotal;
    agg.voteBlamed += r.voteScore.healthyBlamed; agg.voteNicTp += r.voteScore.tp;
    agg.total += scn.faults.length; agg.nicTotal += scn.faults.filter(f => tp.comps[f.comp].type === 'nic').length;
    if (firstAll) agg.allFound++;
    const conf = new Set(a.confirmed), maskedSet = new Map(a.masked.map(m => [m.comp, m.by]));
    for (const f of scn.faults) {
      if (conf.has(f.comp)) continue;
      const st = maskedSet.has(f.comp) ? 'masked' : a.suspect.includes(f.comp) ? 'suspect' : a.watch.includes(f.comp) ? 'watch' : 'cleared';
      agg.missed = agg.missed || {};
      const key = `${f.kind} -> ${st}`;
      agg.missed[key] = (agg.missed[key] || 0) + 1;
      if (st === 'masked') agg.maskedFaults = (agg.maskedFaults || 0) + 1;
    }
    const truth = new Set(scn.faults.map(f => f.comp));
    const masked = new Set(a.masked.map(m => m.comp));
    for (const c of tp.comps) {
      if (!a.nObsComp[c.id] || masked.has(c.id)) continue;
      const p = a.post[c.id];
      const b = Math.min(9, Math.floor(p * 10));
      bins[b].n++; bins[b].sumP += p; bins[b].pos += truth.has(c.id) ? 1 : 0;
    }
    process.stderr.write(`seed ${1000 + s} done\n`);
  }
  console.log(`== ${n} seeds (8 rounds each)`);
  console.log(`adaptive: confirmed ${agg.adTp}/${agg.total} true faults, ${agg.adFp} false confirmations, ${agg.adBlamed} healthy nodes blamed, mean tests ${(agg.adTests / n).toFixed(1)}, all faults found in ${agg.allFound}/${n} clusters`);
  console.log(`random pairings + same inference: confirmed ${agg.rdTp}/${agg.total}, ${agg.rdFp} false, mean tests ${(agg.rdTests / n).toFixed(1)}`);
  console.log(`vote heuristic on random pairings: NIC faults flagged ${agg.voteNicTp}/${agg.nicTotal}, healthy nodes blamed ${agg.voteBlamed} (mean ${(agg.voteBlamed / n).toFixed(1)} per cluster)`);
  console.log('missed faults by kind -> state at round 8:', JSON.stringify(agg.missed));
  console.log(`identifiable faults (not masked by another fault): ${agg.total - (agg.maskedFaults || 0)}, confirmed ${agg.adTp}`);
  console.log('calibration (posterior bin: n, mean p, observed fault rate):');
  bins.forEach((b, i) => { if (b.n) console.log(`  [${i / 10}-${(i + 1) / 10}): n=${b.n}, mean p=${(b.sumP / b.n).toFixed(3)}, rate=${(b.pos / b.n).toFixed(3)}`); });
}
