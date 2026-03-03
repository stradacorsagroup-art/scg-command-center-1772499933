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

function notionValue(prop) {
  if (!prop) return null;
  const t = prop.type;
  if (t === 'title') return (prop.title || []).map((x) => x.plain_text || '').join('').trim() || null;
  if (t === 'rich_text') return (prop.rich_text || []).map((x) => x.plain_text || '').join('').trim() || null;
  if (t === 'number') return prop.number;
  if (t === 'select') return prop.select?.name || null;
  if (t === 'multi_select') return (prop.multi_select || []).map((x) => x.name).join(', ') || null;
  if (t === 'date') return prop.date?.start || null;
  if (t === 'checkbox') return Boolean(prop.checkbox);
  if (t === 'url') return prop.url || null;
  if (t === 'email') return prop.email || null;
  if (t === 'phone_number') return prop.phone_number || null;
  return null;
}

function normalizeStatus(row) {
  const next = row['Next Monthly'] || row['Next Monthly '] || row['First Payment Due'];
  const late = row['LATE'] || row['Late Date'];
  const endDate = row['End Date'];
  const now = new Date();
  if (late && !Number.isNaN(new Date(late).getTime()) && new Date(late) <= now) return 'Late';
  if (next && !Number.isNaN(new Date(next).getTime()) && new Date(next) <= now) return 'Payment Due';
  if (endDate && !Number.isNaN(new Date(endDate).getTime()) && new Date(endDate) <= now) return 'Closeout';
  return 'Live';
}

async function fetchDealsLiveRows() {
  if (!NOTION_TOKEN) return [];
  const rows = [];
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

    for (const page of j.results || []) {
      const props = page.properties || {};
      const row = {};
      for (const [key, val] of Object.entries(props)) row[key] = notionValue(val);
      const car = row.CAR || row.Car || row.Name || Object.values(props).map((p) => notionValue(p)).find(Boolean) || 'Unknown Deal';

      const closedDown = Number(row['Closed Down '] ?? row['SCG Down'] ?? 0) || 0;
      const ownerDown = Number(row['Owner Down'] ?? 0) || 0;
      const closedMonthly = Number(row['Closed Mo'] ?? row['SCG Mo'] ?? 0) || 0;
      const ownerMonthly = Number(row['Owner Mo'] ?? 0) || 0;

      rows.push({
        id: page.id,
        car,
        status: normalizeStatus(row),
        closedDown,
        ownerDown,
        scgDownSpread: closedDown && ownerDown ? closedDown - ownerDown : null,
        brokerPay: Number(row['Broker Pay'] ?? 0) || null,
        deferralAmount: Number(row['Deferral Amount'] ?? 0) || null,
        deferralDueDate: row['Deferral Due Date'] || null,
        closedMonthly,
        ownerMonthly,
        scgMonthlySpread: closedMonthly && ownerMonthly ? closedMonthly - ownerMonthly : null,
        nextMonthly: row['Next Monthly'] || row['Next Monthly '] || row['First Payment Due'] || null,
        lateDate: row['LATE'] || row['Late Date'] || null,
        activationDate: row['Activation Date'] || null,
        endDate: row['End Date'] || null,
        term: row['Term'] || null,
        milesAtActivation: row['Miles at activation'] || null,
        milesAllowed: row['Miles Allowed'] || null,
        buyout: Number(row['Buyout'] ?? 0) || null,
        scgBuyout: Number(row['SCG Buyout'] ?? 0) || null,
        ownerName: row['Owner Name'] || null,
        referral: row['Referral'] || null,
        specialStipulations: row['Special Stipulations'] || row['Stipulations'] || null,
        rawFields: row,
      });
    }

    if (!j.has_more) break;
    cursor = j.next_cursor;
  }
  return rows;
}

async function main() {
  const inventory = await loadInventory();
  const overrides = await loadOverrides();

  const inventoryCount = inventory.length;
  const monthlyTotal = inventory.reduce((s, i) => s + (Number(i.monthly) || 0), 0);
  const avgMonthly = inventoryCount ? Math.round(monthlyTotal / inventoryCount) : 0;
  const dealsLiveRows = await fetchDealsLiveRows().catch(() => []);
  const dealsLiveCount = dealsLiveRows.length || null;

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

  const dealsKanban = {
    syncedAt: live.syncedAt,
    syncedAtEt: live.syncedAtEt,
    columns: ['Live', 'Payment Due', 'Late', 'Closeout'],
    deals: dealsLiveRows,
  };
  const dealsOutPath = path.join(root, 'data', 'deals-kanban.json');
  await fs.writeFile(dealsOutPath, JSON.stringify(dealsKanban, null, 2) + '\n', 'utf8');

  console.log(`Wrote ${outPath}`);
  console.log(`Wrote ${dealsOutPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
