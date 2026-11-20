'use strict';
const express=require('express');
const {Pool}=require('pg');
const crypto=require('crypto');
const path=require('path');
const app=express();
const {DATABASE_URL,ADMIN_PASSWORD,SESSION_SECRET}=process.env;
if(!DATABASE_URL||!ADMIN_PASSWORD||!SESSION_SECRET||ADMIN_PASSWORD.length<12||SESSION_SECRET.length<24){console.error('Set DATABASE_URL, ADMIN_PASSWORD (12+ chars), SESSION_SECRET (24+ chars).');process.exit(1)}
const pool=new Pool({connectionString:DATABASE_URL,ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:true}:false});
// Log slow PostgreSQL operations (query text and parameters are intentionally omitted).
const rawQuery=pool.query.bind(pool);
pool.query=async (...args)=>{
 const start=process.hrtime.bigint();
 try{return await rawQuery(...args)}finally{
  const ms=Number(process.hrtime.bigint()-start)/1e6;
  if(ms>=150)console.log(`[DB_SLOW] duration_ms=${ms.toFixed(1)}`);
 }
};
app.disable('x-powered-by');
app.set('trust proxy',1);
app.use(express.json({limit:'4mb'}));
// Measure real write latency in Render Logs without exposing request bodies or secrets.
app.use('/api',(req,res,next)=>{
 if(!['POST','PUT','PATCH','DELETE'].includes(req.method))return next();
 const start=process.hrtime.bigint();
 res.once('finish',()=>{
  const ms=Number(process.hrtime.bigint()-start)/1e6;
  const route=req.route?.path||req.path.replace(/\/\d+(?=\/|$)/g,'/:id').replace(/\/\d{4}-\d{2}-\d{2}(?=\/|$)/g,'/:date');
  console.log(`[WRITE] ${req.method} ${route} status=${res.statusCode} total_ms=${ms.toFixed(1)} sse_clients=${liveClients.size}`);
 });
 next();
});
app.use((req,res,next)=>{if(['POST','PUT','PATCH','DELETE'].includes(req.method)){const origin=req.headers.origin;if(origin){try{if(new URL(origin).host!==req.get('host'))return res.status(403).json({error:'허용되지 않은 요청입니다.'})}catch{return res.status(403).json({error:'허용되지 않은 요청입니다.'})}}}next()});
app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");next()});
const failures=new Map();
const SESSION_DAYS=30;
const SESSION_MS=SESSION_DAYS*24*60*60*1000;

// Notify connected browsers after a successful database write.
const liveClients=new Set();
function notifyUpdate(change){
 const message=`event: update\ndata: ${JSON.stringify(change)}\n\n`;
 for(const client of liveClients){try{client.write(message)}catch{liveClients.delete(client)}}
}
app.get('/api/events',(req,res)=>{
 res.status(200).set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
 res.flushHeaders();res.write(': connected\n\n');liveClients.add(res);
 const heartbeat=setInterval(()=>{try{res.write(': heartbeat\n\n')}catch{clearInterval(heartbeat);liveClients.delete(res)}},25000);
 req.on('close',()=>{clearInterval(heartbeat);liveClients.delete(res)});
});

function cookie(req){return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=').map(decodeURIComponent)).filter(x=>x.length===2))}
function tokenHash(v){return crypto.createHmac('sha256',SESSION_SECRET).update(v).digest('hex')}
async function current(req){
 const t=cookie(req).charil_session;
 if(!t||!/^[a-f0-9]{64}$/.test(t))return null;
 const r=await pool.query('SELECT expires_at FROM admin_sessions WHERE token_hash=$1 AND expires_at>now()',[tokenHash(t)]);
 return r.rows[0]||null;
}
async function auth(req,res,next){
 try{if(!await current(req))return res.status(401).json({error:'관리자 로그인이 필요합니다.'});next()}
 catch(e){next(e)}
}
function secureCompare(a,b){const ah=crypto.createHash('sha256').update(a).digest();const bh=crypto.createHash('sha256').update(b).digest();return crypto.timingSafeEqual(ah,bh)}
function err(res,e){console.error(e);res.status(500).json({error:'서버 처리 중 오류가 발생했습니다.'})}
const defaultProfile={name:'챠릴',subtitle:'Charil',birthday:'',firstBroadcast:'',mbti:'',fixedTime:'',broadcastDays:'',likes:'',photo:'/assets/profile-sample.webp'};
async function init(){
 await pool.query(`CREATE TABLE IF NOT EXISTS site_profile (id INTEGER PRIMARY KEY DEFAULT 1 CHECK(id=1), data JSONB NOT NULL)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS weekly_schedule (date DATE PRIMARY KEY, category TEXT NOT NULL, title TEXT NOT NULL, time_text TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')`);
 await pool.query(`CREATE TABLE IF NOT EXISTS site_entries (id BIGSERIAL PRIMARY KEY, section TEXT NOT NULL CHECK(section IN ('notice','outfit','reputation')), title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
 await pool.query("ALTER TABLE site_entries ADD COLUMN IF NOT EXISTS outfit_type TEXT NOT NULL DEFAULT '의상'");
 await pool.query('CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL)');
 await pool.query('CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions(expires_at)');
 await pool.query(`CREATE TABLE IF NOT EXISTS reputation_records (id BIGSERIAL PRIMARY KEY, legacy_id BIGINT UNIQUE, name TEXT NOT NULL, viewer_id TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 1 CHECK(count>=0), image TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
 await pool.query(`CREATE TABLE IF NOT EXISTS reputation_progress (viewer_key TEXT NOT NULL, prize_key TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0 CHECK(completed>=0), public_note TEXT NOT NULL DEFAULT '', private_note TEXT NOT NULL DEFAULT '', PRIMARY KEY(viewer_key,prize_key))`);
 // One-time, non-destructive import. Do not re-import records deleted from the new dashboard.
 await pool.query('CREATE TABLE IF NOT EXISTS reputation_migrations (name TEXT PRIMARY KEY)');
 const migration=await pool.query("INSERT INTO reputation_migrations(name) VALUES('legacy_entries_v1') ON CONFLICT DO NOTHING RETURNING name");
 if(migration.rowCount)await pool.query(`INSERT INTO reputation_records(legacy_id,name,description,image,created_at) SELECT id,title,body,image,created_at FROM site_entries WHERE section='reputation' ON CONFLICT(legacy_id) DO NOTHING`);
 await pool.query('INSERT INTO site_profile (id,data) VALUES (1,$1) ON CONFLICT(id) DO NOTHING',[JSON.stringify(defaultProfile)]);
}
app.get('/api/state',async(req,res)=>{try{const [p,s,e,session]=await Promise.all([pool.query('SELECT data FROM site_profile WHERE id=1'),pool.query("SELECT to_char(date,'YYYY-MM-DD') AS date,category,title,time_text AS time,detail FROM weekly_schedule ORDER BY date"),pool.query('SELECT id::text,section,title,body,image,outfit_type,created_at FROM site_entries ORDER BY created_at DESC,id DESC'),current(req)]);res.setHeader('Cache-Control','no-store');res.json({profile:p.rows[0]?.data||defaultProfile,schedule:s.rows,entries:e.rows,admin:!!session})}catch(e){err(res,e)}});
app.get('/api/session',async(req,res)=>{try{res.setHeader('Cache-Control','no-store');res.json({admin:!!(await current(req))})}catch(e){err(res,e)}});
app.post('/api/login',async(req,res)=>{try{
 const ip=req.ip;const record=failures.get(ip)||{n:0,until:0};
 if(record.until>Date.now())return res.status(429).json({error:'잠시 후 다시 시도해 주세요.'});
 if(typeof req.body?.password!=='string'||!secureCompare(req.body.password,ADMIN_PASSWORD)){
  record.n++;if(record.n>=8){record.until=Date.now()+15*60*1000;record.n=0}failures.set(ip,record);
  return res.status(401).json({error:'비밀번호가 올바르지 않습니다.'});
 }
 failures.delete(ip);
 const t=crypto.randomBytes(32).toString('hex');
 await pool.query('INSERT INTO admin_sessions(token_hash,expires_at) VALUES($1,now()+interval \'30 days\')',[tokenHash(t)]);
 res.cookie('charil_session',t,{httpOnly:true,secure:req.secure||process.env.NODE_ENV==='production',sameSite:'strict',path:'/',maxAge:SESSION_MS});
 res.setHeader('Cache-Control','no-store');res.json({ok:true});
}catch(e){err(res,e)}});
app.post('/api/logout',auth,async(req,res)=>{try{
 const t=cookie(req).charil_session;
 if(t)await pool.query('DELETE FROM admin_sessions WHERE token_hash=$1',[tokenHash(t)]);
 res.clearCookie('charil_session',{path:'/',sameSite:'strict',secure:req.secure||process.env.NODE_ENV==='production'});
 res.setHeader('Cache-Control','no-store');res.json({ok:true});
}catch(e){err(res,e)}});
function str(x,max=200){return typeof x==='string'?x.trim().slice(0,max):''}
function imageVal(x){const s=str(x,3500000);if(!s||s==='/assets/profile-sample.webp')return s;if(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s)&&s.length<3500000)return s;throw new Error('지원하지 않는 이미지 형식입니다.')}
app.put('/api/profile',auth,async(req,res)=>{try{const b=req.body||{};const p={name:str(b.name,40),subtitle:str(b.subtitle,80),birthday:str(b.birthday,80),firstBroadcast:str(b.firstBroadcast,100),mbti:str(b.mbti,50),fixedTime:str(b.fixedTime,80),broadcastDays:str(b.broadcastDays,140),likes:str(b.likes,300),photo:imageVal(b.photo)};await pool.query('UPDATE site_profile SET data=$1 WHERE id=1',[JSON.stringify(p)]);notifyUpdate({kind:'profile',profile:p});res.json({profile:p})}catch(e){res.status(400).json({error:e.message})}});
app.put('/api/schedule/:date',auth,async(req,res)=>{try{const d=req.params.date;if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||Number.isNaN(Date.parse(d)))return res.status(400).json({error:'날짜 형식이 올바르지 않습니다.'});const category=str(req.body.category,30),title=str(req.body.title,100),time=str(req.body.time,70),detail=str(req.body.detail,500);if(!['방송','게임','소통','휴방','기타'].includes(category))return res.status(400).json({error:'카테고리를 확인해 주세요.'});await pool.query(`INSERT INTO weekly_schedule(date,category,title,time_text,detail) VALUES($1,$2,$3,$4,$5) ON CONFLICT(date) DO UPDATE SET category=$2,title=$3,time_text=$4,detail=$5`,[d,category,title,time,detail]);notifyUpdate({kind:'schedule',date:d,item:{date:d,category,title,time,detail}});res.json({ok:true,item:{date:d,category,title,time,detail}})}catch(e){err(res,e)}});
app.delete('/api/schedule/:date',auth,async(req,res)=>{try{await pool.query('DELETE FROM weekly_schedule WHERE date=$1',[req.params.date]);notifyUpdate({kind:'schedule',date:req.params.date,item:null});res.json({ok:true,date:req.params.date})}catch(e){err(res,e)}});
app.post('/api/entries',auth,async(req,res)=>{try{const section=str(req.body.section,30),title=str(req.body.title,150),body=str(req.body.body,5000),image=imageVal(req.body.image),outfitType=str(req.body.outfit_type,10)||'의상';if(section==='outfit'&&!['의상','헤어'].includes(outfitType))return res.status(400).json({error:'분류를 확인해 주세요.'});if(!['notice','outfit','reputation'].includes(section)||!title)return res.status(400).json({error:'제목과 종류를 확인해 주세요.'});const r=await pool.query('INSERT INTO site_entries(section,title,body,image,outfit_type) VALUES($1,$2,$3,$4,$5) RETURNING id::text,section,title,body,image,outfit_type,created_at',[section,title,body,image,section==='outfit'?outfitType:'의상']);notifyUpdate({kind:'entry',item:r.rows[0]});res.json({id:r.rows[0].id,item:r.rows[0]})}catch(e){res.status(400).json({error:e.message})}});
app.put('/api/entries/:id',auth,async(req,res)=>{try{const title=str(req.body.title,150),body=str(req.body.body,5000),image=imageVal(req.body.image),outfitType=str(req.body.outfit_type,10)||'의상';if(!['의상','헤어'].includes(outfitType))return res.status(400).json({error:'분류를 확인해 주세요.'});if(!/^\d+$/.test(req.params.id)||!title)return res.status(400).json({error:'항목을 확인해 주세요.'});const r=await pool.query(`UPDATE site_entries SET title=$1,body=$2,image=$3,outfit_type=CASE WHEN section='outfit' THEN $5 ELSE outfit_type END WHERE id=$4 RETURNING id::text,section,title,body,image,outfit_type,created_at`,[title,body,image,req.params.id,outfitType]);if(r.rowCount)notifyUpdate({kind:'entry',item:r.rows[0]});res.status(r.rowCount?200:404).json(r.rowCount?{ok:true,item:r.rows[0]}:{error:'항목을 찾지 못했습니다.'})}catch(e){res.status(400).json({error:e.message})}});
app.delete('/api/entries/:id',auth,async(req,res)=>{try{if(!/^\d+$/.test(req.params.id))return res.status(400).json({error:'잘못된 ID'});await pool.query('DELETE FROM site_entries WHERE id=$1',[req.params.id]);notifyUpdate({kind:'entry',id:req.params.id,item:null});res.json({ok:true,id:req.params.id})}catch(e){err(res,e)}});

// Reputation dashboard, based on the separate roulette site's viewer/prize model.
function repKey(v){return String(v||'').trim().replace(/\s+/g,' ').toLocaleLowerCase()}
function repViewer(r){return r.viewer_id?.trim()?'id:'+r.viewer_id.trim().toLocaleLowerCase():'name:'+repKey(r.name)}
function repParse(r){const raw=String(r.description||'').trim();if(!raw)return [{label:'업보 미등록',qty:Math.max(0,r.count)}];const chunks=raw.split(/[,，\n]+/).map(s=>s.trim()).filter(Boolean);if(chunks.length===1&&!/[＊*]\s*\d+\s*$/.test(raw))return [{label:raw,qty:r.count}];return chunks.map(chunk=>{const m=chunk.match(/^(.*?)[＊*]\s*(\d+)\s*$/);return m&&m[1].trim()?{label:m[1].trim(),qty:Number(m[2])}:{label:chunk,qty:1}})}
const repSelect='SELECT id::text,name,viewer_id,description,count,image,created_at FROM reputation_records';
app.get('/api/reputation',async(req,res)=>{try{const [items,progress]=await Promise.all([pool.query(repSelect+' ORDER BY created_at DESC,id DESC'),pool.query('SELECT viewer_key,prize_key,completed,public_note FROM reputation_progress')]);res.setHeader('Cache-Control','no-store');res.json({items:items.rows,progress:progress.rows})}catch(e){err(res,e)}});
app.get('/api/reputation/private',auth,async(req,res)=>{try{const r=await pool.query('SELECT viewer_key,prize_key,private_note FROM reputation_progress');res.setHeader('Cache-Control','no-store');res.json({notes:r.rows})}catch(e){err(res,e)}});
function repValidate(b){const name=str(b.name,100),viewerId=str(b.viewerId,100),description=str(b.description,10000),count=Number(b.count),image=imageVal(b.image);if(!name||!Number.isSafeInteger(count)||count<0||count>999999)return null;return {name,viewerId,description,count,image}}
app.post('/api/reputation',auth,async(req,res)=>{try{const b=repValidate(req.body||{});if(!b)return res.status(400).json({error:'입력값을 확인해 주세요.'});const r=await pool.query('INSERT INTO reputation_records(name,viewer_id,description,count,image) VALUES($1,$2,$3,$4,$5) RETURNING id::text',[b.name,b.viewerId,b.description,b.count,b.image]);notifyUpdate({kind:'reputation'});res.json({id:r.rows[0].id})}catch(e){err(res,e)}});
app.put('/api/reputation/:id',auth,async(req,res)=>{try{if(!/^\d+$/.test(req.params.id))return res.status(400).json({error:'잘못된 ID'});const b=repValidate(req.body||{});if(!b)return res.status(400).json({error:'입력값을 확인해 주세요.'});const r=await pool.query('UPDATE reputation_records SET name=$1,viewer_id=$2,description=$3,count=$4,image=$5 WHERE id=$6 RETURNING id',[b.name,b.viewerId,b.description,b.count,b.image,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'항목이 없습니다.'});notifyUpdate({kind:'reputation'});res.json({ok:true})}catch(e){err(res,e)}});
app.delete('/api/reputation/:id',auth,async(req,res)=>{try{if(!/^\d+$/.test(req.params.id))return res.status(400).json({error:'잘못된 ID'});const r=await pool.query('DELETE FROM reputation_records WHERE id=$1 RETURNING id',[req.params.id]);if(!r.rowCount)return res.status(404).json({error:'항목이 없습니다.'});notifyUpdate({kind:'reputation'});res.json({ok:true})}catch(e){err(res,e)}});
// Merge a viewer's historical records atomically into one editable record.
app.put('/api/reputation/group/merge',auth,async(req,res)=>{
  const ids=req.body?.recordIds;
  if(!Array.isArray(ids)||!ids.length||ids.length>1000||new Set(ids.map(String)).size!==ids.length||ids.some(id=>!/^[0-9]+$/.test(String(id))))return res.status(400).json({error:'업보 기록을 확인해 주세요.'});
  const b=repValidate(req.body||{});
  if(!b||!b.description.trim())return res.status(400).json({error:'업보 내용을 입력해 주세요.'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const records=await client.query(repSelect+' WHERE id::text = ANY($1::text[]) FOR UPDATE',[ids.map(String)]);
    if(records.rows.length!==ids.length)throw Object.assign(new Error('기록이 변경되었습니다. 새로고침 후 다시 시도해 주세요.'),{status:409});
    const keys=new Set(records.rows.map(repViewer));
    if(keys.size!==1)throw Object.assign(new Error('서로 다른 시청자의 기록은 합칠 수 없습니다.'),{status:400});
    const keep=records.rows[0];
    await client.query('UPDATE reputation_records SET name=$1,viewer_id=$2,description=$3,count=$4,image=$5 WHERE id=$6',[b.name,b.viewerId,b.description,b.count,b.image,keep.id]);
    const removed=records.rows.filter(r=>r.id!==keep.id).map(r=>r.id);
    if(removed.length)await client.query('DELETE FROM reputation_records WHERE id::text = ANY($1::text[])',[removed]);
    await client.query('COMMIT');notifyUpdate({kind:'reputation'});res.json({ok:true});
  }catch(e){await client.query('ROLLBACK');if(e.status)return res.status(e.status).json({error:e.message});err(res,e)}finally{client.release()}
});
app.put('/api/reputation/progress/save',auth,async(req,res)=>{try{const b=req.body||{},viewerKey=str(b.viewerKey,250),prizeKey=str(b.prizeKey,300),completed=Number(b.completed),publicNote=str(b.publicNote,3000),privateNote=str(b.privateNote,3000);if(!viewerKey||!prizeKey||!Number.isSafeInteger(completed)||completed<0)return res.status(400).json({error:'진행 정보를 확인해 주세요.'});const rows=await pool.query(repSelect);let total=0;for(const r of rows.rows){if(repViewer(r)!==viewerKey)continue;for(const prize of repParse(r))if(repKey(prize.label)===prizeKey)total+=prize.qty}if(!total||completed>total)return res.status(400).json({error:'완료 수량이 전체 수량보다 많거나 업보가 없습니다.'});await pool.query(`INSERT INTO reputation_progress(viewer_key,prize_key,completed,public_note,private_note) VALUES($1,$2,$3,$4,$5) ON CONFLICT(viewer_key,prize_key) DO UPDATE SET completed=EXCLUDED.completed,public_note=EXCLUDED.public_note,private_note=EXCLUDED.private_note`,[viewerKey,prizeKey,completed,publicNote,privateNote]);notifyUpdate({kind:'reputation'});res.json({ok:true})}catch(e){err(res,e)}});

app.use(express.static(path.join(__dirname,'public'),{index:'index.html'}));
app.get('/health',(_req,res)=>res.json({ok:true}));
init().then(()=>app.listen(process.env.PORT||3000,()=>console.log('Charil profile listening'))).catch(e=>{console.error('Database initialization failed:',e);process.exit(1)});
