// One-shot: re-run inferCategory against every market in the DB and update
// rows whose category has drifted. Use after the inferCategory regex changes.
//
// Usage: source .env.local first, then `npx tsx scripts/recategorize-markets.ts`

import { sql } from "../lib/db";
import { inferCategory } from "../lib/polymarket";

async function main() {
  const db = sql();
  const rows = await db`SELECT id, question, category FROM markets`;
  console.log(`[recat] Loaded ${rows.length} markets`);

  let changed = 0;
  for (const r of rows) {
    const id = r.id as string;
    const question = r.question as string;
    const oldCat = r.category as string;
    const newCat = inferCategory(question);
    if (newCat !== oldCat) {
      await db`UPDATE markets SET category = ${newCat} WHERE id = ${id}`;
      console.log(`[recat] ${oldCat} → ${newCat}: ${question.slice(0, 60)}`);
      changed++;
    }
  }
  console.log(`[recat] Done. ${changed} updated, ${rows.length - changed} unchanged`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
