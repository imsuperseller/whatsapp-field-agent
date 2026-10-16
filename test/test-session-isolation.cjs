const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'waha-session-test-'));process.env.WAHA_DIR=dir;fs.mkdirSync(path.join(dir,'logs'));fs.writeFileSync(path.join(dir,'.env'),'WAHA_API_KEY=test\nSITE_URL=https://example.invalid\nWHATSAPP_BRIDGE_SECRET=test\n');
fs.writeFileSync(path.join(dir,'watched-groups.json'),JSON.stringify({groups:{'T@g.us':{name:'customer',session:'acme',tenant_slug:'customer',may_post:true},'D@g.us':{name:'demo',session:'sandbox',tenant_slug:'demo-locksmith',may_post:true}}}));
const sends=[];const brains=[];
global.fetch=async(url,opt={})=>{
 if(String(url).endsWith('/api/sessions'))return{ok:true,json:async()=>[{name:'acme',me:{id:'111@c.us'}},{name:'sandbox',me:{id:'222@c.us'}}]};
 if(String(url).includes('/groups'))return{ok:true,json:async()=>[{JID:'T@g.us',Participants:[{JID:'tech@lid',PhoneNumber:'1000'}]},{JID:'D@g.us',Participants:[{JID:'tech@lid',PhoneNumber:'1000'}]}]};
 if(String(url).endsWith('/api/whatsapp/tech-support')){brains.push(JSON.parse(opt.body));return{ok:true,json:async()=>({answer:'Documented answer.'})}}
 if(String(url).endsWith('/api/sendText')){sends.push(JSON.parse(opt.body));return{ok:true}}
 throw new Error('unexpected request '+url);
};
(async()=>{try{const{handle}=require('../bridge.js');const event=(from,id,body)=>({from,id,body,participant:'tech@lid',timestamp:Math.floor(Date.now()/1000),fromMe:false});
 assert.equal(await handle(event('T@g.us','one','@111 what key is specified?'),'acme'),'answered');
 assert.equal(await handle(event('D@g.us','two','@222 what key is specified?'),'sandbox'),'answered');
 assert.equal(await handle(event('T@g.us','three','what key is specified?'),'sandbox'),'wrong gateway session');
 assert.equal(await handle(event('D@g.us','two','@222 what key is specified?'),'sandbox'),'already handled');
 assert.deepEqual(brains.map(x=>x.tenantSlug),['customer','demo-locksmith']);assert.deepEqual(sends.map(x=>x.session),['acme','sandbox']);console.log('PASS separate session identities, tenant routing, wrong-session refusal and duplicate suppression');
}finally{fs.rmSync(dir,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1});
