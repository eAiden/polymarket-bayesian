// One-shot: re-run inferCategory against every market in the DB and update
// rows whose category has drifted. Use after the inferCategory regex changes.
//
// Usage: source .env.local first, then `npx tsx scripts/recategorize-markets.ts`

import { sql } from "../lib/db";

// Inline copy of inferCategory so we don't need to export it from polymarket.ts.
// Keep in sync with lib/polymarket.ts.
function inferCategory(question: string): string {
  const q = question.toLowerCase();
  if (/\bbtc\b|bitcoin|\beth\b|ether(eum)?|\bcrypto|solana|\bsol\b|\bxrp\b|doge|defi|\bnft\b|blockchain|coinbase|binance|stablecoin|altcoin/.test(q)) return "Crypto";
  if (/elect|president|senate|congress|democrat|republican|trump|biden|harris|vance|nato|parliament|geopolit|prime minister|chancellor|\bpm\b|cabinet|impeach|coup|referendum|primary|gubernatorial|iran|israel|ukrain|russia|putin|zelensky|netanyahu|gaza|hamas|hezbollah|ceasefire|invasion|sanction|war\b|conflict|treaty|summit|tariff|deport|immigration/.test(q)) return "Politics";
  if (/\bnba\b|\bnfl\b|\bmlb\b|\bnhl\b|world cup|super bowl|playoff|champion|fifa|tennis|golf|ufc|olympic|premier league|la liga|bundesliga|serie a|champions league|europa league|uefa|formula 1|\bf1\b|masters|wimbledon|us open|grand slam|barcelona|real madrid|arsenal|chelsea|psg|liverpool|bayern|juventus|manchester|tottenham|atletico|inter milan|ac milan|sporting cp|aston villa|celtics|lakers|warriors|thunder|cowboys|patriots|chiefs|yankees|dodgers|messi|ronaldo|lebron|curry|mahomes|scheffler|mcilroy|djokovic/.test(q)) return "Sports";
  if (/\bfed\b|federal reserve|interest rate|inflation|\bgdp\b|recession|unemployment|\bcpi\b|\bpce\b|nasdaq|s&p|dow jones|stock market|\boil\b|crude|\bwti\b|brent|opec|gasoline|natural gas|gold|silver|copper|commodity|currency|dollar|\bforex\b|\beur\b|\byen\b|\byuan\b|bond|treasury|yield|earnings|ipo|merger|acquisition|bankruptcy|nvidia|tesla|apple|microsoft|google|amazon|meta|largest company/.test(q)) return "Economics";
  if (/\bai\b|artificial intelligence|openai|gpt|claude|anthropic|llm|spacex|starship|nasa|rocket|launch|climate|vaccine|\bfda\b|\bcdc\b|\bwho\b|pandemic|outbreak|earthquake|hurricane|tornado|wildfire|volcano|asteroid|eclipse/.test(q)) return "Science";
  if (/eurovision|oscar|grammy|emmy|tony award|cannes|sundance|box office|netflix|disney|marvel|taylor swift|drake|kendrick|beyonce|kardashian|grammy|album|movie|film|premiere/.test(q)) return "Entertainment";
  return "Other";
}

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
