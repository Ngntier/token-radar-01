// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// The board ranks every protocol that records no token and is not a wrapped, staked or bridged
// product of a token that trades: the watchlist's own rule, applied to the whole snapshot instead of
// only above the floor. That is the 40 watchlist protocols plus every rankable pre-token protocol
// below the floor — the early rows the radar exists to find. Live-token protocols are kept apart and
// shown as the market's own values, never mixed into the ranked board.
//
// Implied value is a comparables valuation, calibrated from the snapshot's own live-token protocols:
//
//   multiple(category) = shrink(median mcap/TVL of live peers in the category, global median)
//   base       = tvl_usd x multiple(category)
//   growthMult = 1 + clamp(change_7d, -50, 100) / 100 x 0.6
//   maturity   = 0.55 + min(age_days, 1095) / 1095 x 0.45   (age_days unknown: 365)
//   breadth    = 1 + 0.02 x min(chains - 1, 8)
//   implied    = max(1, round(base x growthMult x maturity x breadth))
//
// The category median is winsorised to [0.02, 1.0] and shrunk toward the global median with weight
// n / (n + 5), so a category with one noisy peer cannot set the multiple on its own. No protocol name
// is ever special-cased: the same function scores every row, and the dashboard shows the calibration
// table the multiples came from.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  breadth_per_chain: number;
  breadth_max_extra: number;
  shrink_k: number;
  median_floor: number;
  median_cap: number;
  multiple_floor: number;
  multiple_cap: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.6,
  growth_floor: -50,
  growth_cap: 100,
  maturity_floor: 0.55,
  maturity_range: 0.45,
  maturity_days: 1095,
  unknown_age_days: 365,
  breadth_per_chain: 0.02,
  breadth_max_extra: 8,
  shrink_k: 5,
  median_floor: 0.02,
  median_cap: 1.0,
  multiple_floor: 0.05,
  multiple_cap: 1.0,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the comparables view carries, by market cap. */
export const LIVE_ROWS = 40;

/** One category's calibration: the live peers it was priced from. */
export interface CategoryMultiple {
  category: string;
  peers: number;
  median: number;
  multiple: number;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    category_peers: number;
    category_median: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  why: string;
  risks: string[];
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  multiple: number;
  category_peers: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  watchlist: boolean;
  why: string;
  risks: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  mcap_tvl_ratio: number;
}

/** Everything the dashboard needs: the board, the live set, the calibration and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  total_implied_usd: number;
  calibration: CategoryMultiple[];
  global_multiple: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a non-empty list of numbers, sorted; 0 when empty. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories the watchlist's rule keeps out: wrapped, staked or bridged products, and exchanges. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Exchange names a wrapped or staked product's name begins with. */
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether a protocol is a wrapped, staked or bridged product of a token that already trades. */
export function isWrappedProduct(p: SnapshotProtocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return true;
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return true;
  if (EXCHANGES.some((e) => p.name.startsWith(e))) return true;
  if (VERSIONED.test(p.name)) return true;
  return false;
}

/** Whether a protocol is one the board may rank: pre-token, not a wrapped product, not versioned. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !isWrappedProduct(p);
}

/** The live-token protocols that price the multiples: a real market cap on a real TVL, no exchanges. */
export function livePeers(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX',
  );
}

/**
 * The calibration: the global median mcap/TVL of the live peers, and one multiple per category —
 * the category's median, winsorised, shrunk toward the global median by peer count, then clamped.
 */
export function calibrate(snapshot: Snapshot, model: ModelConstants = MODEL): { global: number; byCategory: Map<string, CategoryMultiple> } {
  const peers = livePeers(snapshot);
  const global = median(peers.map((p) => p.mcap_usd! / p.tvl_usd));
  const byCategory = new Map<string, CategoryMultiple>();
  const cats = new Map<string, number[]>();
  for (const p of peers) {
    const c = p.category ?? 'Other';
    if (!cats.has(c)) cats.set(c, []);
    cats.get(c)!.push(p.mcap_usd! / p.tvl_usd);
  }
  for (const [category, ratios] of cats) {
    const raw = median(ratios);
    const win = Math.min(model.median_cap, Math.max(model.median_floor, raw));
    const w = ratios.length / (ratios.length + model.shrink_k);
    const multiple = Math.min(model.multiple_cap, Math.max(model.multiple_floor, w * win + (1 - w) * global));
    // The stored median is the raw one — what the calibration table shows; the winsorised value is
    // only the formula's input, so a category with one wild peer reads honestly.
    byCategory.set(category, { category, peers: ratios.length, median: round4(raw), multiple: round4(multiple) });
  }
  return { global: round4(global), byCategory };
}

/** The multiple one protocol is priced at: its category's, or the global median when it has no peers. */
export function multipleFor(p: SnapshotProtocol, calibration: { global: number; byCategory: Map<string, CategoryMultiple> }, model: ModelConstants = MODEL): CategoryMultiple {
  const c = p.category ?? 'Other';
  const found = calibration.byCategory.get(c);
  if (found !== undefined) return found;
  const multiple = Math.min(model.multiple_cap, Math.max(model.multiple_floor, calibration.global));
  return { category: c, peers: 0, median: calibration.global, multiple: round4(multiple) };
}

/** The four multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  calibration: { global: number; byCategory: Map<string, CategoryMultiple> },
  model: ModelConstants = MODEL,
): { implied: number; multiple: CategoryMultiple; growthPct: number; growthMult: number; maturityMult: number; breadthMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const extra = Math.min(Math.max(protocol.chains.length - 1, 0), model.breadth_max_extra);
  const breadthMult = 1 + extra * model.breadth_per_chain;
  const multiple = multipleFor(protocol, calibration, model);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple.multiple * growthMult * maturityMult * breadthMult));
  return { implied, multiple, growthPct, growthMult, maturityMult, breadthMult, age };
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** An age in days as a short human phrase. */
export function agePhrase(age: number | null): string {
  if (age === null) return 'unknown age';
  if (age >= 365) return `${(age / 365).toFixed(1)}y`;
  return `${Math.max(0, Math.round(age))}d`;
}

/** The risk flags a row carries, each derived from its own figures. */
export function riskFlags(p: SnapshotProtocol, age: number | null): string[] {
  const risks: string[] = [];
  if (p.change_7d !== null && p.change_7d < -5) risks.push('TVL falling 7d');
  if (age !== null && age < 180) risks.push('Young protocol');
  if (age === null) risks.push('Age unknown');
  if (p.chains.length <= 1) risks.push('Single chain');
  if (p.tvl_usd < 25_000_000) risks.push('Small TVL');
  return risks;
}

/** The one-line reason a row holds its rank, from its own figures and its category standing. */
export function whySentence(
  p: SnapshotProtocol,
  scored: { p: SnapshotProtocol; implied: number }[],
  age: number | null,
  watchlist: boolean,
): string {
  const same = scored.filter((s) => (s.p.category ?? 'Other') === (p.category ?? 'Other')).sort((a, b) => b.p.tvl_usd - a.p.tvl_usd);
  const place = same.findIndex((s) => s.p.slug === p.slug) + 1;
  const cat = p.category ?? 'Other';
  const parts: string[] = [];
  if (place === 1) parts.push(`Largest TVL of any pre-token ${cat} protocol`);
  else if (place <= 3) parts.push(`#${place} TVL among pre-token ${cat} protocols`);
  else parts.push(`${cat} protocol`);
  if (p.change_7d !== null && p.change_7d >= 5) parts.push(`+${p.change_7d.toFixed(1)}% TVL in 7d`);
  else if (p.change_7d !== null && p.change_7d <= -5) parts.push(`${p.change_7d.toFixed(1)}% TVL in 7d`);
  if (age !== null && age >= 365) parts.push(`${agePhrase(age)} running with no token`);
  else if (age !== null && age < 180) parts.push(`young at ${agePhrase(age)}`);
  if (watchlist) parts.push('on the watchlist');
  if (p.chains.length >= 4) parts.push(`live on ${p.chains.length} chains`);
  return parts.join(' · ');
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const calibration = calibrate(snapshot, model);
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but
  // the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every rankable pre-token protocol below the watchlist floor, whatever its TVL.
  // Never a replacement for a watchlist row: a chosen protocol stays chosen.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, calibration, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    watchlist: snapshot.watchlist.includes(s.p.slug),
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      category_multiple: s.multiple.multiple,
      category_peers: s.multiple.peers,
      category_median: s.multiple.median,
      growth_pct: round4(s.growthPct),
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      breadth_multiplier: round4(s.breadthMult),
      age_days: s.age,
    },
    why: whySentence(s.p, scored, s.age, snapshot.watchlist.includes(s.p.slug)),
    risks: riskFlags(s.p, s.age),
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** Cheap chains, where a transaction costs cents rather than dollars. */
const CHEAP_CHAINS = new Set([
  'Arbitrum', 'Optimism', 'Base', 'Polygon', 'Blast', 'Linea', 'Scroll', 'zkSync', 'Mantle', 'Mode',
  'Ink', 'Abstract', 'Starknet', 'Gnosis', 'Celo', 'Aurora', 'Solana', 'Sui', 'Aptos', 'Near',
  'Avalanche', 'Binance', 'Fantom', 'Moonbeam', 'Metis', 'Boba', 'Kava', 'Sei', 'Berachain', 'Sonic',
]);

/** What one transaction costs on a chain, as a short phrase. */
function gasFor(chain: string): string {
  if (chain === 'Ethereum') return 'about $12 of gas';
  if (chain === 'Solana' || chain === 'Sui' || chain === 'Aptos' || chain === 'Near') return 'about $0.05 of gas';
  if (CHEAP_CHAINS.has(chain)) return 'about $0.50 of gas';
  return 'about $3 of gas';
}

/** The category's main action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('liquidity manager')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('yield') || c.includes('leveraged farm') || c.includes('farm')) return `Deposit $${capital} of USDC into ${name}'s main vault on ${chain} and keep the shares.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('index')) return `Buy $${capital} of ${name}'s index token on ${chain} and hold it.`;
  if (c.includes('card')) return `Order ${name}'s card, fund it with $${capital} and spend from it once.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The category's second qualifying action, different from the first. */
function secondActionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow a small amount against your ${name} supply, then repay half of it, so the position shows both sides.`;
  if (c.includes('dex') || c.includes('liquidity manager')) return `Route one swap through ${name}'s pool on ${chain} so the wallet shows trading activity as well as liquidity.`;
  if (c.includes('yield') || c.includes('leveraged farm') || c.includes('farm')) return `Harvest the vault's rewards once and re-deposit them into the same ${name} vault.`;
  if (c.includes('bridge')) return `Bridge a small amount back through ${name} so the wallet shows a round trip.`;
  if (c.includes('staking') || c.includes('restak')) return `Claim the staking rewards once and re-stake them through ${name}.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis')) return `Close the hedge and open a fresh one, so the position is not a single stale trade.`;
  if (c.includes('prediction')) return `Place a second position on a different ${name} market and let both settle.`;
  if (c.includes('curator') || c.includes('allocator')) return `Add a second deposit to a different ${name} vault on ${chain}.`;
  if (c.includes('stable')) return `Use the stable asset in one of ${name}'s pools on ${chain} instead of holding it idle.`;
  if (c.includes('rwa')) return `Claim the yield once and add it back to the same ${name} position.`;
  if (c.includes('insurance')) return `Check the policy's terms on ${name} and top the cover up if it has lapsed.`;
  if (c.includes('index')) return `Check ${name}'s rebalance schedule and add $${Math.max(10, Math.round(capital / 5))} after the next one.`;
  if (c.includes('card')) return `Pay one bill with ${name}'s card so the account shows repeat use.`;
  return `Make a second deposit of $${Math.max(10, Math.round(capital / 5))} into ${name} on ${chain} a week later.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and ${gas}`,
      time: '15 minutes to set up',
    },
    {
      text: secondActionFor(p, capital, chain),
      cost: gas,
      time: '10 minutes',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: `${gas} a week`,
      time: '10 minutes a week',
    },
    {
      text: `Check the protocol's own points or rewards page once a week and finish any quest it publishes.`,
      cost: 'no fee to check',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, claim only from the link the protocol itself publishes, and write the wallet, the dates and every transaction in a farm log.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's comparables view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return livePeers(snapshot)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
      mcap_tvl_ratio: round4(p.mcap_usd! / p.tvl_usd),
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    multiple: row.model.category_multiple,
    category_peers: row.model.category_peers,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
    watchlist: row.watchlist,
    why: row.why,
    risks: row.risks,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const calibration = calibrate(snapshot, model);
  const early = board.filter((r) => !r.watchlist).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    total_implied_usd: board.reduce((n, r) => n + r.implied_value_usd, 0),
    calibration: [...calibration.byCategory.values()].sort((a, b) => b.peers - a.peers || (a.category < b.category ? -1 : 1)),
    global_multiple: calibration.global,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100) return `the board holds ${board.length} rows, fewer than the 100 the gate needs`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
