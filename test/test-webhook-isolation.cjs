const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
test('signed inbound events reach bridge; forged, outgoing and wrong-path events never do',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'waha-receiver-test-'));fs.mkdirSync(path.join(dir,'logs'));
 fs.writeFileSync(path.join(dir,'.env'),'WHATSAPP_HOOK_HMAC_KEY=test-secret\n');
 fs.writeFileSync(path.join(dir,'bridge.js'),`exports.handle=async(p,s)=>require('fs').appendFileSync(${JSON.stringify(path.join(dir,'calls.jsonl'))},JSON.stringify({id:p.id,session:s})+'\\n');`);
 const child=spawn(process.execPath,[path.join(__dirname,'..','webhook-receiver.js')],{env:{...process.env,WAHA_DIR:dir,WAHA_WEBHOOK_PORT:'0'},stdio:['ignore','pipe','pipe']});
 // The child reports its assigned ephemeral port; no fixed service port is used.
 try{
 const port=await new Promise((resolve,reject)=>{child.stdout.on('data',x=>{const m=String(x).match(/:(\d+)/);if(m)resolve(Number(m[1]))});child.once('error',reject);child.once('exit',()=>reject(new Error('receiver exited before ready')))});
 const post=async(event,fromMe,signed=true,route='/waha/webhook')=>{const body=JSON.stringify({event,session:'demo',payload:{id:event+fromMe,fromMe,body:'test'}});return fetch(`http://127.0.0.1:${port}${route}`,{method:'POST',headers:{'x-webhook-hmac':signed?crypto.createHmac('sha512','test-secret').update(body).digest('hex'):'0'.repeat(128)},body});};
 assert.equal((await post('message',false,false)).status,401);
 assert.equal((await post('message',false,true,'/wrong')).status,404);
 assert.equal((await post('message',true)).status,200);
 assert.equal((await post('message',false)).status,200);
 assert.equal((await post('message.any',false)).status,200);
 assert.equal((await post('session.status',false)).status,200);
 await new Promise(r=>setTimeout(r,60));
 const calls=fs.readFileSync(path.join(dir,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.deepEqual(calls,[{id:'messagefalse',session:'demo'},{id:'message.anyfalse',session:'demo'}]);
 // webhook.jsonl proves each signed delivery arrived and keeps none of what was said.
 const lines=fs.readFileSync(path.join(dir,'logs','webhook.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(lines.length,4,'four signed deliveries; the forged one is refused before logging');
 assert.ok(lines.every(l=>!('payload' in l)&&l.chars===4&&!JSON.stringify(l).includes('"test"')));
 }finally{child.kill();await new Promise(r=>child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});}
});

test('a question the bridge failed to answer is kept with its text, so it is never lost',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'waha-receiver-crash-'));fs.mkdirSync(path.join(dir,'logs'));
 fs.writeFileSync(path.join(dir,'.env'),'WHATSAPP_HOOK_HMAC_KEY=test-secret\n');
 fs.writeFileSync(path.join(dir,'bridge.js'),`exports.handle=async()=>{throw new Error('brain down')};`);
 const child=spawn(process.execPath,[path.join(__dirname,'..','webhook-receiver.js')],{env:{...process.env,WAHA_DIR:dir,WAHA_WEBHOOK_PORT:'0'},stdio:['ignore','pipe','pipe']});
 try{
 const port=await new Promise((resolve,reject)=>{child.stdout.on('data',x=>{const m=String(x).match(/:(\d+)/);if(m)resolve(Number(m[1]))});child.once('error',reject);child.once('exit',()=>reject(new Error('receiver exited before ready')))});
 const body=JSON.stringify({event:'message',session:'acme',payload:{id:'q1',from:'120363@g.us',participant:'5@lid',fromMe:false,body:'what blank for a 2019 ram?'}});
 assert.equal((await fetch(`http://127.0.0.1:${port}/waha/webhook`,{method:'POST',headers:{'x-webhook-hmac':crypto.createHmac('sha512','test-secret').update(body).digest('hex')},body})).status,200);
 await new Promise(r=>setTimeout(r,60));
 const notes=fs.readFileSync(path.join(dir,'logs','bridge.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const crash=notes.find(n=>n.verdict==='bridge threw');
 assert.ok(crash,'the failure is recorded');
 assert.equal(crash.text,'what blank for a 2019 ram?'); assert.equal(crash.chatId,'120363@g.us');
 assert.equal(fs.readFileSync(path.join(dir,'logs','webhook.jsonl'),'utf8').includes('2019 ram'),false,'arrival log still keeps no text');
 }finally{child.kill();await new Promise(r=>child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});}
});
