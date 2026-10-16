const assert=require('node:assert/strict');
const {webhookRecord,webhookContainsEcho}=require('../watchdog-log');
const raw=(over={})=>({event:'message.any',session:'sandbox',payload:{id:'m1',from:'1555@c.us',fromMe:true,body:'roundtrip-k3x9-ab12cd',...over}});
const line=(p,signatureOk=true)=>JSON.stringify(webhookRecord({at:'t',url:'/waha/webhook',signatureOk,payload:p}))+'\n';
const prefix=Buffer.from('עברית לפני הבדיקה\n'.repeat(200));
const log=l=>Buffer.concat([prefix,Buffer.from(l)]);
const nonce='roundtrip-k3x9-ab12cd';
// Byte offsets, not characters: the Hebrew prefix is longer in bytes than in characters.
assert.equal(log(line(raw())).toString('utf8').slice(prefix.length).includes(nonce),false,'old character slicing reproduces the missed echo');
assert.equal(webhookContainsEcho(log(line(raw())),prefix.length,nonce,'sandbox'),true);
for(const l of [line(raw(),false),line({...raw(),session:'acme'}),line(raw({fromMe:false}))])assert.equal(webhookContainsEcho(log(l),prefix.length,nonce,'sandbox'),false);
assert.equal(webhookContainsEcho(log(line(raw())),prefix.length,'roundtrip-other-000000','sandbox'),false);
assert.equal(webhookContainsEcho(Buffer.from(''),0,nonce,'sandbox'),false);
// A log rotated between the send and the read is smaller than the old offset.
assert.equal(webhookContainsEcho(Buffer.from(line(raw())),prefix.length+10_000,nonce,'sandbox'),true,'rotated log is read from the start');
// The line proves arrival and never keeps what was said.
const said='מחר בשמונה אצלי, תביא את הילדים';
const rec=webhookRecord({at:'t',url:'/waha/webhook',signatureOk:true,payload:{event:'message',session:'acme',payload:{id:'false_120363@g.us_3EB0C0FFEE_972500000000@c.us',from:'120363@g.us',participant:'972500000000@c.us',fromMe:false,body:said,notifyName:'Avi',_data:{Info:{PushName:'Avi'}}}}});
assert.deepEqual(rec,{at:'t',url:'/waha/webhook',event:'message',session:'acme',signatureOk:true,id:rec.id,chat:'group',group:'120363@g.us',ts:null,fromMe:false,hasMedia:false,chars:said.length,status:null,roundtrip:null});
assert.match(rec.id,/^[0-9a-f]{16}$/,'message id kept only as a digest: real ids embed the chat and sender number');
assert.equal(JSON.stringify(rec).includes('Avi')||JSON.stringify(rec).includes('972500000000'),false,'no sender name or number kept');
// Our own message that merely looks like a nonce in a group is not echoed; anything else we send keeps no body.
assert.equal(webhookRecord({signatureOk:true,payload:{event:'message',session:'s',payload:{fromMe:true,from:'1@g.us',body:'see you at 8'}}}).roundtrip,null);
// A private chat keeps neither its id nor any number; a group keeps its id and send time.
const dm=webhookRecord({signatureOk:true,payload:{event:'message',session:'acme',payload:{id:'false_972500000000@c.us_X',from:'972500000000@c.us',timestamp:1790000000,fromMe:false,body:'hi'}}});
assert.equal(dm.group,null); assert.equal(dm.ts,1790000000); assert.equal(JSON.stringify(dm).includes('972500000000'),false,'no number from a private chat');
console.log('PASS byte offsets, rotation, exact signed/session/nonce echo, and no message content kept');
