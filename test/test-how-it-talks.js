/**
 * Every answer here is one Bobot ACTUALLY SENT to the Field Techs group,
 * copied from the group export — not invented. Sam asked the crew on
 * 2026-08-28 to help fine-tune "the answers format and the info presented";
 * this file is that feedback turned into a gate.
 *
 * The crew's own register, from the same export: "hu101 is the non trans",
 * "Hu101 or h94 i believe for the transponder", "Scan the bcm codes if you can",
 * "Check the alternator". Short, plain, no packaging.
 */
const path = require('path');
const { formatWhatsAppAnswer } = require(path.join(__dirname, '..', 'bridge.js'));

// 2026-08-27 12:43 — Sam asked for a key blank and got this, twice.
const CATALOG_WALL = `Answer:
1. 2020 Ford Escape
2. Key Blank: 164-R8182
3. FCC ID: M3N-A2C931426
4. Types available: smart, flip, remote, transponder
5. Source: UHS catalog
6. Also found:
7. 2018-2023 Ford Expedition Escape / 4-Button Smart Key / PN: 164-R8197 / M3N-A2C931423 (RSK-FD-EP2004) [FCC: M3N-A2C931423]
8. 2011-2020 Ford / 5-Button PEPS Smart Key / PN: BT4T-15K601-HC / M3N5WY8609 (AFTERMARKET) (RSK-FD-GLSHN) [FCC: M3N5WY8609]
9. 2017-2022 Ford / Hatch / 5-Button Smart Key SHELL for M3N-A2C931426 (AFTERMARKET) (SKS-FD-060)
10. 2013-2020 Ford / 5-Button Smart Key / PEPS / PN: 164-R7995 / M3N5WY8609 (AFTERMARKET) (RSK-FD-HSGLS)
11. Ask if you need programming instructions for this vehicle.
12. From the shop chat (programming notes):
13. (Michel Jordan) All US Citizens are Entitled to $700 USD per week to stay at home to avoid the spread of COVID-19 novel Coronavirus, starting from March 16, 2020. Read full article here on how to claim: https://external-preview.redd.it/vxPXEGgL4v8mCGw06IFGsmJNtqWQg-z60xQQ79dHKPY.jpg
14. (Sam F) Anyone knows if one of our programmers can do a 2020 Kia Telluride proxy?`;

// 2026-08-28 16:11 — the answer Alex.K told the group it got right.
const PROCEDURE = `Answer:
1. The excerpts only cover specific Toyota models. Here's the add-mode remote programming process for the **2008 and 2011 Toyota Yaris** (same procedure for both):
2. Start with driver's door open & unlocked, key out of ignition
3. Insert & remove key **2 times within 5 seconds**
4. Close & open driver's door **twice within 40 seconds**
5. Insert key into ignition & remove
6. Close & open driver's door **twice within 40 seconds**
7. Insert key into ignition
8. Close the door
9. Turn ignition **LOCK → ON → LOCK — ONE time** (that's ADD mode)
10. Remove key from ignition
11. Locks will cycle to confirm — number of cycles matches your step 8 count
12. Within 40 seconds:
13. Press **Lock + Unlock simultaneously**
14. Repeat step 11 for each additional remote
15. Open door to exit programming`;

// 2026-08-29 10:43 — the short refusal.
const REFUSAL = `Answer:
1. I do have something on this in the shop knowledge, but not an answer I can give you here.
2. Ask Sam.`;

// 2026-08-31, taken from the LIVE route after the merge — same content, but the
// branch emits 🔹 bullets rather than numbering. A fixture that only carried the
// numbered form let four aftermarket rows straight through.
const CATALOG_WALL_BULLETED = `Answer:
🔹 2020 Ford Escape
🔹 Key Blank: 164-R8182
🔹 FCC ID: M3N-A2C931426
🔹 Types available: smart, flip, remote, transponder
🔹 Source: UHS catalog
🔹 Also found:
🔹 2018-2023 Ford Expedition Escape / 4-Button Smart Key / PN: 164-R8197 / M3N-A2C931423 (RSK-FD-EP2004) [FCC: M3N-A2C931423]
🔹 2011-2020 Ford / 5-Button PEPS Smart Key / PN: BT4T-15K601-HC / M3N5WY8609 (AFTERMARKET) (RSK-FD-GLSHN) [FCC: M3N5WY8609]
🔹 Ask if you need programming instructions for this vehicle.`;

// 2026-08-31, live: what the metal-blade question returns now.
const BLADE = `Answer:
🔹 The mechanical blade for the 2020 Ford Escape is **HU101**.`;

const cases = [
  {
    name: 'catalog answer: the blank, not the catalogue',
    out: formatWhatsAppAnswer(CATALOG_WALL),
    checks: [
      ['keeps the blank', (o) => o.includes('164-R8182')],
      ['no "Answer:" preamble', (o) => !/^answer:/i.test(o)],
      ['no list numbering', (o) => !/^\d+\.\s/m.test(o)],
      ['no bullet glyphs or our own name', (o) => !/🔹|🔧|\*Bobot\*/.test(o)],
      ['drops "Source: UHS catalog"', (o) => !/UHS catalog/i.test(o)],
      ['drops "Also found:" AND the alternates under it', (o) => !/also found/i.test(o) && !/AFTERMARKET|RSK-FD|SKS-FD/i.test(o)],
      ['drops the "ask if you need" upsell', (o) => !/ask if you need/i.test(o)],
      ['NEVER leaks the shop-chat spam', (o) => !/COVID|redd\.it|\$700/i.test(o)],
      ['never leaks another tech\'s unrelated chat', (o) => !/Kia Telluride/i.test(o)],
      ['short enough to read on a truck', (o) => o.length <= 200],
      ['four lines at most', (o) => o.split('\n').length <= 4],
    ],
  },
  {
    name: 'catalog answer, live bulleted form: same cut',
    out: formatWhatsAppAnswer(CATALOG_WALL_BULLETED),
    checks: [
      ['keeps the blank', (o) => o.includes('164-R8182')],
      ['drops the alternates', (o) => !/AFTERMARKET|RSK-FD|Also found/i.test(o)],
      ['drops the upsell line', (o) => !/ask if you need/i.test(o)],
      ['three lines', (o) => o.split('\n').length === 3],
      ['no bullets, no "Answer:"', (o) => !/🔹|^answer:/im.test(o)],
    ],
  },
  {
    name: 'the metal blade question, live: one line, the way his tech said it',
    out: formatWhatsAppAnswer(BLADE),
    checks: [
      ['one line', (o) => o.split('\n').length === 1],
      ['says HU101', (o) => o.includes('HU101')],
      ['no ** bold **, no bullets, no "Answer:"', (o) => !/\*\*|🔹|^answer:/im.test(o)],
      ['under 80 characters', (o) => o.length < 80],
    ],
  },
  {
    name: 'procedure: kept whole and numbered',
    out: formatWhatsAppAnswer(PROCEDURE),
    checks: [
      ['keeps every step', (o) => o.split('\n').length >= 12],
      ['steps stay numbered', (o) => /^1\.\s/m.test(o) && /^9\.\s/m.test(o)],
      ['no "Answer:" preamble', (o) => !/^answer:/i.test(o)],
      ['no ** bold **', (o) => !o.includes('**')],
      ['no bullet glyphs', (o) => !/🔹|🔧/.test(o)],
      ['still says LOCK → ON → LOCK', (o) => o.includes('LOCK → ON → LOCK')],
    ],
  },
  {
    name: 'refusal: two plain lines',
    out: formatWhatsAppAnswer(REFUSAL),
    checks: [
      ['two lines', (o) => o.split('\n').length === 2],
      ['no numbering, no bullets, no header', (o) => !/^\d+\.|🔹|🔧/m.test(o)],
      ['still names Sam', (o) => /Ask Sam/.test(o)],
    ],
  },
];

let fails = 0;
for (const c of cases) {
  console.log(`\n── ${c.name}\n${c.out.split('\n').map((l) => `   │ ${l}`).join('\n')}`);
  for (const [label, fn] of c.checks) {
    const ok = fn(c.out);
    if (!ok) fails++;
    console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  }
}
console.log(fails ? `\n${fails} check(s) wrong` : '\nit talks the way the crew talks');
process.exit(fails ? 1 : 0);
