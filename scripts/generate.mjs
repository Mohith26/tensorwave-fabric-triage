// Seeded synthetic scenario: a 128-node MI355X training cluster (4 pods x 32 nodes x 8 rails)
// with hidden faults of three kinds. Run: node scripts/generate.mjs > data/scenario.json
import { mulberry32, hashSeed, buildTopology } from '../src/fabric.js';

export function generateScenario(seed = 20261110, cfg = {}) {
  const pods = cfg.pods || ['p13', 'p14', 'p15', 'p16'];
  const nodesPerPod = cfg.nodesPerPod || 32;
  const rails = cfg.rails || 8;
  const nNic = cfg.nNic ?? 5, nLeaf = cfg.nLeaf ?? 1, nUp = cfg.nUp ?? 1, nFlaky = cfg.nFlaky ?? 1;
  const maxRounds = cfg.maxRounds ?? 9;
  const topo = buildTopology({ pods, nodesPerPod, rails });
  const rng = mulberry32(hashSeed(seed, 'scenario'));
  const pick = arr => arr[Math.floor(rng() * arr.length)];
  const faults = [];
  const usedNodes = new Set(), usedPR = new Set();
  const kinds = [
    { label: 'Optic lane down', sev: [0.48, 0.52] },
    { label: 'CRC errors / retransmits', sev: [0.62, 0.82] },
    { label: 'Mild degradation', sev: [0.84, 0.89] },
  ];
  for (let k = 0; k < nNic; k++) {
    let n; do { n = Math.floor(rng() * topo.N); } while (usedNodes.has(n));
    usedNodes.add(n);
    const r = Math.floor(rng() * rails);
    const kind = k < nFlaky ? { label: 'Flapping link', sev: [0.55, 0.7] } : kinds[k % kinds.length];
    const severity = +(kind.sev[0] + rng() * (kind.sev[1] - kind.sev[0])).toFixed(3);
    faults.push({ comp: topo.nicId(n, r), kind: kind.label, severity, intermittency: k < nFlaky ? 0.5 : 1 });
  }
  for (let k = 0; k < nLeaf + nUp; k++) {
    let p, r; do { p = Math.floor(rng() * topo.P); r = Math.floor(rng() * rails); } while (usedPR.has(`${p}/${r}`));
    usedPR.add(`${p}/${r}`);
    const leaf = k < nLeaf;
    faults.push({
      comp: leaf ? topo.leafId(p, r) : topo.upId(p, r),
      kind: leaf ? 'Leaf port buffer / PFC misconfig' : 'Spine uplink down (1 of 4)',
      severity: +(leaf ? 0.68 + rng() * 0.08 : 0.73 + rng() * 0.04).toFixed(3),
      intermittency: 1,
    });
  }
  // Idle schedule: nodes allocated to customer jobs cannot be tested that round.
  const busy = [];
  for (let round = 1; round <= maxRounds; round++) {
    const rr = mulberry32(hashSeed(seed, 'busy', round));
    const b = new Set();
    if (round === 1) { const start = Math.floor(rr() * (topo.N - 8)); for (let n = start; n < start + 8; n++) b.add(n); }
    for (let n = 0; n < topo.N; n++) if (rr() < 0.08) b.add(n);
    busy.push([...b].sort((x, y) => x - y));
  }
  void pick;
  return {
    seed, cluster: 'tus1', clusterName: 'tus1 Training Cluster', sku: 'MI355X', lineGbps: 400,
    pods, nodesPerPod, rails, faults, busy,
    note: 'Synthetic. Faults are hidden from inference; used only to simulate ib_write_bw results and to score.',
  };
}

const isMain = typeof process !== 'undefined' && process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) console.log(JSON.stringify(generateScenario(), null, 1));
