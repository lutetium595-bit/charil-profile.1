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
const sessions=new Map();const failures=new Map();

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
function current(req){const t=cookie(req).charil_session;if(!t)return null;const s=sessions.get(tokenHash(t));if(!s||s.expires<Date.now()){if(s)sessions.delete(tokenHash(t));return null}return s}
function auth(req,res,next){if(!current(req))return res.status(401).json({error:'관리자 로그인이 필요합니다.'});next()}
function secureCompare(a,b){const ah=crypto.createHash('sha256').update(a).digest();const bh=crypto.createHash('sha256').update(b).digest();return crypto.timingSafeEqual(ah,bh)}
function err(res,e){console.error(e);res.status(500).json({error:'서버 처리 중 오류가 발생했습니다.'})}
const defaultProfile={name:'챠릴',subtitle:'Charil',birthday:'',firstBroadcast:'',mbti:'',fixedTime:'',broadcastDays:'',likes:'',photo:'/assets/profile-sample.webp'};
async function init(){
 await pool.query(`CREATE TABLE IF NOT EXISTS site_profile (id INTEGER PRIMARY KEY DEFAULT 1 CHECK(id=1), data JSONB NOT NULL)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS weekly_schedule (date DATE PRIMARY KEY, category TEXT NOT NULL, title TEXT NOT NULL, time_text TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')`);
 await pool.query(`CREATE TABLE IF NOT EXISTS site_entries (id BIGSERIAL PRIMARY KEY, section TEXT NOT NULL CHECK(section IN ('notice','outfit','reputation')), title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
 await pool.query('INSERT INTO site_profile (id,data) VALUES (1,$1) ON CONFLICT(id) DO NOTHING',[JSON.stringify(defaultProfile)]);
}
app.get('/api/state',async(req,res)=>{try{const [p,s,e]=await Promise.all([pool.query('SELECT data FROM site_profile WHERE id=1'),pool.query("SELECT to_char(date,'YYYY-MM-DD') AS date,category,title,time_text AS time,detail FROM weekly_schedule ORDER BY date"),pool.query('SELECT id::text,section,title,body,image,created_at FROM site_entries ORDER BY created_at DESC,id DESC')]);res.setHeader('Cache-Control','no-store');res.json({profile:p.rows[0]?.data||defaultProfile,schedule:s.rows,entries:e.rows,admin:!!current(req)})}catch(e){err(res,e)}});
app.get('/api/session',(req,res)=>res.json({admin:!!current(req)}));
app.post('/api/login',(req,res)=>{const ip=req.ip;const record=failures.get(ip)||{n:0,until:0};if(record.until>Date.now())return res.status(429).json({error:'잠시 후 다시 시도해 주세요.'});if(typeof req.body.password!=='string'||!secureCompare(req.body.password,ADMIN_PASSWORD)){record.n++;if(record.n>=8){record.until=Date.now()+15*60*1000;record.n=0}failures.set(ip,record);return res.status(401).json({error:'비밀번호가 올바르지 않습니다.'})}failures.delete(ip);const t=crypto.randomBytes(32).toString('hex');sessions.set(tokenHash(t),{expires:Date.now()+12*3600*1000});res.cookie('charil_session',t,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',path:'/',maxAge:12*3600*1000});res.json({ok:true})});
app.post('/api/logout',auth,(req,res)=>{const t=cookie(req).charil_session;if(t)sessions.delete(tokenHash(t));res.clearCookie('charil_session',{path:'/'});res.json({ok:true})});
function str(x,max=200){return typeof x==='string'?x.trim().slice(0,max):''}
function imageVal(x){const s=str(x,3500000);if(!s||s==='/assets/profile-sample.webp')return s;if(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s)&&s.length<3500000)return s;throw new Error('지원하지 않는 이미지 형식입니다.')}
app.put('/api/profile',auth,async(req,res)=>{try{const b=req.body||{};const p={name:str(b.name,40),subtitle:str(b.subtitle,80),birthday:str(b.birthday,80),firstBroadcast:str(b.firstBroadcast,100),mbti:str(b.mbti,50),fixedTime:str(b.fixedTime,80),broadcastDays:str(b.broadcastDays,140),likes:str(b.likes,300),photo:imageVal(b.photo)};await pool.query('UPDATE site_profile SET data=$1 WHERE id=1',[JSON.stringify(p)]);notifyUpdate({kind:'profile',profile:p});res.json({profile:p})}catch(e){res.status(400).json({error:e.message})}});
app.put('/api/schedule/:date',auth,async(req,res)=>{try{const d=req.params.date;if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||Number.isNaN(Date.parse(d)))return res.status(400).json({error:'날짜 형식이 올바르지 않습니다.'});const category=str(req.body.category,30),title=str(req.body.title,100),time=str(req.body.time,70),detail=str(req.body.detail,500);if(!['방송','게임','소통','휴방','기타'].includes(category))return res.status(400).json({error:'카테고리를 확인해 주세요.'});await pool.query(`INSERT INTO weekly_schedule(date,category,title,time_text,detail) VALUES($1,$2,$3,$4,$5) ON CONFLICT(date) DO UPDATE SET category=$2,title=$3,time_text=$4,detail=$5`,[d,category,title,time,detail]);notifyUpdate({kind:'schedule',date:d,item:{date:d,category,title,time,detail}});res.json({ok:true,item:{date:d,category,title,time,detail}})}catch(e){err(res,e)}});
app.delete('/api/schedule/:date',auth,async(req,res)=>{try{await pool.query('DELETE FROM weekly_schedule WHERE date=$1',[req.params.date]);notifyUpdate({kind:'schedule',date:req.params.date,item:null});res.json({ok:true,date:req.params.date})}catch(e){err(res,e)}});
app.post('/api/entries',auth,async(req,res)=>{try{const section=str(req.body.section,30),title=str(req.body.title,150),body=str(req.body.body,5000),image=imageVal(req.body.image);if(!['notice','outfit','reputation'].includes(section)||!title)return res.status(400).json({error:'제목과 종류를 확인해 주세요.'});const r=await pool.query('INSERT INTO site_entries(section,title,body,image) VALUES($1,$2,$3,$4) RETURNING id::text,section,title,body,image,created_at',[section,title,body,image]);notifyUpdate({kind:'entry',item:r.rows[0]});res.json({id:r.rows[0].id,item:r.rows[0]})}catch(e){res.status(400).json({error:e.message})}});
app.put('/api/entries/:id',auth,async(req,res)=>{try{const title=str(req.body.title,150),body=str(req.body.body,5000),image=imageVal(req.body.image);if(!/^\d+$/.test(req.params.id)||!title)return res.status(400).json({error:'항목을 확인해 주세요.'});const r=await pool.query('UPDATE site_entries SET title=$1,body=$2,image=$3 WHERE id=$4 RETURNING id::text,section,title,body,image,created_at',[title,body,image,req.params.id]);if(r.rowCount)notifyUpdate({kind:'entry',item:r.rows[0]});res.status(r.rowCount?200:404).json(r.rowCount?{ok:true,item:r.rows[0]}:{error:'항목을 찾지 못했습니다.'})}catch(e){res.status(400).json({error:e.message})}});
app.delete('/api/entries/:id',auth,async(req,res)=>{try{if(!/^\d+$/.test(req.params.id))return res.status(400).json({error:'잘못된 ID'});await pool.query('DELETE FROM site_entries WHERE id=$1',[req.params.id]);notifyUpdate({kind:'entry',id:req.params.id,item:null});res.json({ok:true,id:req.params.id})}catch(e){err(res,e)}});
app.use(express.static(path.join(__dirname,'public'),{index:'index.html'}));
app.get('/health',(_req,res)=>res.json({ok:true}));
init().then(()=>app.listen(process.env.PORT||3000,()=>console.log('Charil profile listening'))).catch(e=>{console.error('Database initialization failed:',e);process.exit(1)});
