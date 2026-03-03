#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const inventoryTsPath = path.join(root, '..', 'scg-site', 'src', 'data', 'inventory.ts');
const outPath = path.join(root, 'data', 'live.json');
const overridesPath = path.join(root, 'data', 'overrides.json');

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

async function main() {
  const inventory = await loadInventory();
  const overrides = await loadOverrides();

  const inventoryCount = inventory.length;
  const monthlyTotal = inventory.reduce((s, i) => s + (Number(i.monthly) || 0), 0);
  const avgMonthly = inventoryCount ? Math.round(monthlyTotal / inventoryCount) : 0;

  const live = {
    syncedAt: new Date().toISOString(),
    syncedAtEt: nowEtLabel(),
    kpis: {
      carsOnRoad: overrides.kpis?.carsOnRoad ?? inventoryCount,
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
