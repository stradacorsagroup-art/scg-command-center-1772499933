#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const inventoryTsPath = path.join(root, '..', 'scg-site', 'src', 'data', 'inventory.ts');
const outPath = path.join(root, 'data', 'live.json');
const overridesPath = path.join(root, 'data', 'overrides.json');
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2025-09-03';
const DEALS_LIVE_DATA_SOURCE_ID = process.env.DEALS_LIVE_DATA_SOURCE_ID || '2fb53b52-84ce-81af-94e7-000b07d7144b';

function nowEtLabel() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }) + ' ET';
}

async function loadInventory() {
  const txt = await fs.readFile(inventoryTsPath, 'utf8');
  const m = txt.match(/export const inventory: InventoryItem\[] = ([\s\S]*?)\n];/);
  if (!m) throw new Error('Could not parse inventory array');
  const json = m[1] + '\n]';
  return JSON.parse(json);
}

async function loadOverrides() {
  try {
    const txt = await fs.readFile(overridesPath, 'utf8');
    return JSON.parse(txt);
  } catch {
    return {};
  }
}

async function fetchDealsLiveCount() {
  if (!NOTION_TOKEN) return null;
  let total = 0;
  let cursor = undefined;
  while (true) {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(`https://api.notion.com/v1/data_sources/${DEALS_LIVE_DATA_SOURCE_ID}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Deals LIVE query failed (${res.status}): ${t}`);
    }
    const j = await res.json();
    total += (j.results || []).length;
    if (!j.has_more) break;
    cursor = j.next_cursor;
  }
  return total;
}

async function main() {
  const inventory = await loadInventory();
  const overrides = await loadOverrides();

  const inventoryCount = inventory.length;
  const monthlyTotal = inventory.reduce((s, i) => s + (Number(i.monthly) || 0), 0);
  const avgMonthly = inventoryCount ? Math.round(monthlyTotal / inventoryCount) : 0;
  const dealsLiveCount = await fetchDealsLiveCount().catch(() => null);

  const live = {
    syncedAt: new Date().toISOString(),
    syncedAtEt: nowEtLabel(),
    kpis: {
      carsOnRoad: overrides.kpis?.carsOnRoad ?? dealsLiveCount ?? inventoryCount,
      cashCollected: overrides.kpis?.cashCollected ?? 0,
      scgProfit: overrides.kpis?.scgProfit ?? 0,
      activeLeads: overrides.kpis?.activeLeads ?? 8,
      pipelineValue: overrides.kpis?.pipelineValue ?? monthlyTotal,
      avgMonthly,
    },
    monthGoals: {
      revenue: {
        current: overrides.monthGoals?.revenue?.current ?? 0,
        target: overrides.monthGoals?.revenue?.target ?? 200000,
      },
      deals: {
        current: overrides.monthGoals?.deals?.current ?? 0,
        target: overrides.monthGoals?.deals?.target ?? 5,
      },
      infra: {
        current: overrides.monthGoals?.infra?.current ?? 0,
        target: overrides.monthGoals?.infra?.target ?? 5,
      },
    },
    todayTop3: overrides.todayTop3 ?? [
      { name: 'Close Jerome', detail: 'Sign OA + walk Vision Doc in person', done: false },
      { name: 'Website media complete', detail: 'Map all live inventory assets', done: false },
      { name: 'File Montana LLC', detail: 'SCG Capital Partners LLC', done: false },
    ],
    inventory: {
      count: inventoryCount,
      avgMonthly,
    },
  };

  await fs.writeFile(outPath, JSON.stringify(live, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
