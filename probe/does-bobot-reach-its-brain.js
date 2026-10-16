#!/usr/bin/env node
'use strict';
/**
 * Does Bobot still reach its answering brain, running the code in this folder?
 *
 * Why this exists (2026-09-22). Bobot was stored in five places: the gateway on
 * the the server server, a copy in Agent OS, the answering brain in this app,
 * settings on Vercel, and tenant rows in the database. Every break was one place
 * moving while another stayed put:
 *   - the tenant slug was renamed on 2026-09-11 and the server config kept the
 *     old one, so Bobot answered nobody for about a week;
 *   - the same rename broke the Vercel tester allowlist (a hash of slug + phone),
 *     so the one path that could prove the whole chain was dead;
 *   - the running gateway had not been committed anywhere since 2026-08-31;
 *   - the brain sent video links in a field the gateway never read.
 * The server's own watchdog proves WhatsApp reaches our webhook. Nothing proved
 * the webhook reaches the brain, so each of these stayed green.
 *
 * Three checks, run over SSH on the server. None of them sends a WhatsApp
 * message, writes a row, or spends an AI call:
 *   1. Every file the server's services load is byte-identical to this folder.
 *   2. Each watched group with a tester resolves to a real tenant, and the live
 *      site admits the tester (not 404 unknown_tenant, not 403
 *      tester_not_authorized).
 *   3. The live brain speaks the current contract: an owner_teach from a tester
 *      is refused with saved:false. That branch returns before any write.
 *   4. The box has ffmpeg, which the bridge needs to hear a voice note or look at
 *      a video (2026-10-15). It also prints each posting group's off days, so a
 *      quiet Sunday can be read from the run log instead of guessed at.
 *
 * Exit 0 = all three hold · 1 = broken (says what) · 2 = server not reachable.
 * Env: VPS_HOST, VPS_USER (default root@<server-ip>).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = path.resolve(__dirname, '..');
const TARGET = `${process.env.VPS_USER || 'root'}@${process.env.VPS_HOST || '<server-ip>'}`;
// Every file a service on the server loads. Keep in step with deploy/runtime-files.
const FILES = require('../deploy/runtime-files.json');

const REMOTE = `
const fs=require('fs'),crypto=require('crypto');
const files=${JSON.stringify(FILES)};
const out={hashes:{},groups:[],ffmpeg:null};
try{out.ffmpeg=require('child_process').execFileSync('ffmpeg',['-version'],{encoding:'utf8',timeout:10000}).split('\\n')[0]}catch(e){out.ffmpeg=null}
for(const f of files){try{out.hashes[f]=crypto.createHash('sha256').update(fs.readFileSync('/opt/waha/'+f)).digest('hex')}catch(e){out.hashes[f]=null}}
const e=Object.fromEntries(fs.readFileSync('/opt/waha/.env','utf8').split('\\n').filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1)]}));
const groups=Object.values(JSON.parse(fs.readFileSync('/opt/waha/watched-groups.json','utf8')).groups||{});
(async()=>{
  for(const g of groups){
    const row={name:g.name,slug:g.tenant_slug,testers:(g.tester_phones||[]).length,
      posts_daily:Boolean(g.may_post&&g.daily_messages&&g.daily_messages.enabled!==false),
      skip_weekdays:g.daily_messages?(g.daily_messages.skip_weekdays===undefined?'default (Sun)':JSON.stringify(g.daily_messages.skip_weekdays)):null};
    if(row.testers){
      try{
        const r=await fetch(e.SITE_URL+'/api/whatsapp/tech-support',{method:'POST',
          headers:{'x-bridge-secret':e.WHATSAPP_BRIDGE_SECRET,'Content-Type':'application/json'},
          body:JSON.stringify({tenantSlug:g.tenant_slug,phone:String(g.tester_phones[0]),tester:true,
            question:'probe: does bobot reach its brain',action:'owner_teach',provisionalAnswer:'probe, never saved'}),
          signal:AbortSignal.timeout(30000)});
        const t=await r.text();let b={};try{b=JSON.parse(t)}catch(_){}
        row.status=r.status;row.error=b.error||null;row.saved=b.saved;
        row.refused=typeof b.answer==='string'&&/only .* can save/i.test(b.answer);
      }catch(err){row.status=null;row.error=String(err&&err.message||err)}
    }
    out.groups.push(row);
  }
  console.log(JSON.stringify(out));
})();
`;

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(HERE, file))).digest('hex');
}

function main() {
  const res = spawnSync('ssh', ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', TARGET, 'node', '-'], {
    input: REMOTE, encoding: 'utf8', timeout: 120000,
  });
  if (res.error || res.status !== 0 || !String(res.stdout || '').trim()) {
    console.log(`could not ask the Bobot server (${res.error ? res.error.message : `ssh exit ${res.status}`}): ${String(res.stderr || '').trim().slice(0, 200)}`);
    return 2;
  }
  const data = JSON.parse(res.stdout.trim().split('\n').pop());
  const problems = [];
  for (const file of FILES) {
    const live = data.hashes[file];
    if (live == null) problems.push(`${file} is missing on the server`);
    else if (live !== sha256(file)) problems.push(`${file} on the server differs from apps/whatsapp-gateway/${file}`);
  }
  if (!data.ffmpeg) problems.push('ffmpeg is missing on the server — Bobot cannot hear a voice note or look at a video');
  const tested = data.groups.filter((g) => g.testers);
  if (!tested.length) problems.push('no watched group has a tester, so the brain path cannot be proven');
  for (const g of tested) {
    const who = `${g.name} (${g.slug})`;
    if (g.status === 404) problems.push(`${who}: the live site does not know this tenant slug`);
    else if (g.status === 403 && g.error === 'tester_not_authorized') problems.push(`${who}: the tester is refused — the Vercel tester allowlist no longer matches slug + phone`);
    else if (g.status !== 200) problems.push(`${who}: the brain answered ${g.status} ${g.error || ''}`.trim());
    else if (!(g.saved === false && g.refused)) problems.push(`${who}: the live brain does not speak the current contract (owner_teach not refused)`);
  }
  if (problems.length) {
    console.log(`Bobot is not proven end to end: ${problems.join('; ')}`);
    return 1;
  }
  const daily = data.groups.filter((g) => g.posts_daily).map((g) => `${g.name} off on ${g.skip_weekdays}`);
  console.log(`Bobot reaches its brain: the server runs this folder's code (${FILES.length} files), ${data.ffmpeg} is on the box, and the tester gets through for ${tested.map((g) => g.name).join(', ')}${daily.length ? `; daily messages: ${daily.join('; ')}` : ''}`);
  return 0;
}

process.exit(main());
