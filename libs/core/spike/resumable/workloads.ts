export interface Workload {
  name: string;
  source: string;
}

export const AGGREGATE: Workload = {
  name: 'aggregate-3000',
  source: `
const result = await callTool('orders.list', { page: 1 });
const rows = result.rows;
const byRegion = {};
let skipped = 0;
for (const row of rows) {
  if (row.status === 'cancelled') {
    skipped++;
    continue;
  }
  const key = row.region;
  if (!byRegion[key]) {
    byRegion[key] = { region: key, orders: 0, revenue: 0, units: 0, big: 0 };
  }
  const group = byRegion[key];
  const total = row.amount * row.quantity;
  group.orders += 1;
  group.revenue += total;
  group.units += row.quantity;
  if (total > 500) group.big += 1;
}
const summary = [];
for (const key of Object.keys(byRegion)) {
  const g = byRegion[key];
  summary.push({ region: g.region, orders: g.orders, revenue: Math.round(g.revenue), units: g.units, big: g.big, avg: Math.round(g.revenue / g.orders) });
}
return { skipped, summary };
`,
};

export const CALLBACKS: Workload = {
  name: 'callbacks-3000',
  source: `
const result = await callTool('orders.list', { page: 1 });
const live = result.rows.filter((r) => r.status !== 'cancelled');
const enriched = live.map((r) => ({ id: r.id, region: r.region, total: r.amount * r.quantity }));
const revenue = enriched.reduce((sum, r) => sum + r.total, 0);
const best = enriched.reduce((top, r) => (r.total > top.total ? r : top), enriched[0]);
const north = enriched.filter((r) => r.region === 'north').length;
return { count: enriched.length, best: best.id, revenue: Math.round(revenue), north };
`,
};

export const SORT: Workload = {
  name: 'sort-2400',
  source: `
const result = await callTool('orders.list', { page: 1 });
const live = result.rows.filter((r) => r.status !== 'cancelled');
const top = live.slice().sort((a, b) => b.amount * b.quantity - a.amount * a.quantity).slice(0, 10).map((r) => r.id);
return top;
`,
};

export const FANOUT: Workload = {
  name: 'parallel-50',
  source: `
const list = await callTool('accounts.list', { limit: 50 });
const details = await parallel(list.ids, async (id) => {
  const account = await callTool('accounts.get', { id });
  let flags = 0;
  for (const tx of account.recent) {
    if (tx > 400) flags++;
  }
  return { id, tier: account.balance > 1000 ? 'high' : 'low', balance: account.balance, flags };
});
const high = details.filter((d) => d.tier === 'high');
return { total: details.length, high: high.length, balance: high.reduce((s, d) => s + d.balance, 0), flagged: details.filter((d) => d.flags > 2).map((d) => d.id) };
`,
};

export const APPROVAL: Workload = {
  name: 'parallel-approval',
  source: `
const ids = [1, 2, 3, 4, 5];
const voided = await parallel(ids, async (id) => {
  const receipt = await callTool('invoices.void', { id });
  return receipt.status + ':' + id;
});
return voided;
`,
};

export const COLLECTIONS: Workload = {
  name: 'closures-and-collections',
  source: `
const seen = new Set();
const totals = new Map();
const add = (key, value) => {
  totals.set(key, (totals.get(key) || 0) + value);
};
const result = await callTool('orders.list', { page: 1 });
for (const row of result.rows.slice(0, 300)) {
  if (seen.has(row.customer)) continue;
  seen.add(row.customer);
  add(row.region, row.quantity);
}
const out = {};
for (const [key, value] of totals) out[key] = value;
return { unique: seen.size, out };
`,
};

export const WORKLOADS = [AGGREGATE, CALLBACKS, FANOUT, SORT];

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REGIONS = ['north', 'south', 'east', 'west', 'central'];
const STATUSES = ['paid', 'paid', 'paid', 'pending', 'cancelled'];

export function makeRows(count: number): Array<Record<string, unknown>> {
  const rand = prng(42);
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      id: `ord_${i}`,
      region: REGIONS[Math.floor(rand() * REGIONS.length)],
      status: STATUSES[Math.floor(rand() * STATUSES.length)],
      amount: Math.round(rand() * 20000) / 100,
      quantity: 1 + Math.floor(rand() * 5),
      customer: `cus_${Math.floor(rand() * 400)}`,
    });
  }
  return rows;
}

const ROWS = makeRows(3000);

export const calls: string[] = [];

export async function toolHandler(name: string, args: unknown): Promise<unknown> {
  const a = (args ?? {}) as Record<string, unknown>;
  calls.push(`${name}${a['id'] !== undefined ? `#${String(a['id'])}` : ''}`);
  switch (name) {
    case 'orders.list':
      return { rows: ROWS };
    case 'accounts.list':
      return { ids: Array.from({ length: Number(a['limit'] ?? 50) }, (_, i) => `acc_${i}`) };
    case 'accounts.get': {
      const rand = prng(String(a['id']).length * 7919 + Number(String(a['id']).slice(4)));
      return {
        id: a['id'],
        balance: Math.round(rand() * 2000),
        recent: Array.from({ length: 8 }, () => Math.round(rand() * 500)),
      };
    }
    case 'invoices.void':
      return { status: 'voided' };
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
