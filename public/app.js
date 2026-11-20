'use strict';
const $=s=>document.querySelector(s);
const state={profile:{},schedule:[],entries:[],admin:false,page:'home',week:weekStart(new Date()),month:new Date(new Date().getFullYear(),new Date().getMonth(),1)};
let selectedOutfitType='의상';
const weekdays=['월','화','수','목','금','토','일'];
function weekStart(d){const n=new Date(d.getFullYear(),d.getMonth(),d.getDate());n.setDate(n.getDate()-(n.getDay()+6)%7);return n}
function addDays(d,n){const x=new Date(d);x.setDate(x.getDate()+n);return x}
function dateKey(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function dateShort(d){return `${d.getMonth()+1}.${String(d.getDate()).padStart(2,'0')}`}
function showToast(message){const t=$('#toast');t.textContent=message;t.style.display='block';clearTimeout(showToast.t);showToast.t=setTimeout(()=>t.style.display='none',3500)}
async function api(url,opts={}){const r=await fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json'},...opts});let j={};try{j=await r.json()}catch{}if(!r.ok)throw new Error(j.error||'요청에 실패했습니다.');return j}
let refreshInFlight=null;
let refreshQueued=false;
let localWritePending=0;
// SSE carries the saved record, so do not reload the entire database on every edit.
let refreshStartedAt=0;
let lastLiveChangeAt=0;
function applyChange(change){
 if(!change||typeof change!=='object')return false;
 if(change.kind==='profile'&&change.profile){state.profile=change.profile;renderProfile();return true}
 if(change.kind==='schedule'&&typeof change.date==='string'){
  state.schedule=state.schedule.filter(s=>s.date!==change.date);
  if(change.item)state.schedule.push(change.item);
  renderWeek();renderMonth();return true;
 }
 if(change.kind==='entry'){
  const id=String(change.item?.id??change.id??'');if(!id)return false;
  state.entries=state.entries.filter(e=>String(e.id)!==id);
  if(change.item)state.entries.unshift(change.item);
  renderEntries();return true;
 }
 return false;
}
async function refresh(){
 if(refreshInFlight){refreshQueued=true;return refreshInFlight}
 refreshInFlight=(async()=>{
  const started=Date.now();
  refreshStartedAt=started;
  const data=await api('/api/state',{cache:'no-store'});
  // An SSE change received while this request was running is newer than its snapshot.
  if(lastLiveChangeAt>started){refreshQueued=true;return}
  Object.assign(state,data);document.body.classList.toggle('is-admin',state.admin);render();
 })();
 try{await refreshInFlight}finally{
  refreshInFlight=null;
  if(refreshQueued){refreshQueued=false;queueMicrotask(()=>refresh().catch(e=>console.warn('갱신 실패:',e)))}
 }
}
let updateTimer;
function scheduleRefresh(){clearTimeout(updateTimer);updateTimer=setTimeout(()=>refresh().catch(e=>console.warn('자동 갱신 실패:',e)),100)}
if(typeof EventSource!=='undefined'){
 const live=new EventSource('/api/events');
 let openedOnce=false;
 live.addEventListener('update',event=>{
  try{
   const change=JSON.parse(event.data);
   lastLiveChangeAt=Date.now();
   // Apply the event immediately, including while this tab is saving.
   // The old code did a costly full /api/state reload for every local edit.
   if(!applyChange(change))scheduleRefresh();
  }catch(e){console.warn('실시간 이벤트 처리 실패:',e);scheduleRefresh()}
 });
 live.addEventListener('open',()=>{
  // Only re-sync on reconnection, not on the initial SSE connection.
  if(openedOnce)scheduleRefresh();
  openedOnce=true;
 });
}
// Safety net for missed events; SSE itself updates the UI without polling.
setInterval(()=>{if(!document.hidden)scheduleRefresh()},60000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)scheduleRefresh()});
async function saveChange(url,opts,changeFromResult){
 localWritePending++;
 try{const result=await api(url,opts);const change=changeFromResult(result);if(!applyChange(change))await refresh();return result}
 finally{localWritePending--}
}

function render(){renderProfile();renderWeek();renderMonth();renderEntries()}
function renderProfile(){const p=state.profile;$('#profileName').textContent=p.name||'챠릴';$('#profileSubtitle').textContent=p.subtitle||'Charil';const defaultPhoto='/assets/profile-sample.webp';const photo=p.photo||defaultPhoto;if($('#portrait').getAttribute('src')!==photo)$('#portrait').src=photo;$('#portrait').closest('.portrait-panel').classList.toggle('default-portrait',photo===defaultPhoto);for(const el of document.querySelectorAll('[data-profile]'))el.textContent=p[el.dataset.profile]||''}
function scheduleFor(d){return state.schedule.find(s=>s.date===dateKey(d))}
function weekRow(d,i){const s=scheduleFor(d);const row=document.createElement('div');row.className='week-row'+(i===6?' sunday':'')+(!s?' empty':'');const day=document.createElement('span');day.className='day';day.textContent=weekdays[i];const date=document.createElement('span');date.className='date';date.textContent=dateShort(d);const title=document.createElement('span');title.className='activity';title.textContent=s?`${icon(s.category)} ${s.title||s.category}`:'—';const time=document.createElement('span');time.className='time';time.textContent=s?.time||'';row.append(day,date,title,time);row.title=s?.detail||'';return row}
function icon(cat){return {방송:'',게임:'',소통:'',휴방:'',기타:''}[cat]||'☆'}
function renderWeek(){const a=state.week,b=addDays(a,6);$('#weekLabel').textContent=`${dateShort(a)} ~ ${dateShort(b)}`;const home=$('#homeWeek');home.replaceChildren();for(let i=0;i<7;i++){const d=addDays(a,i),s=scheduleFor(d);home.append(weekRow(d,i));}}
function renderMonth(){
 const m=state.month,year=m.getFullYear(),month=m.getMonth();
 $('#monthLabel').textContent=`${year}년 ${month+1}월`;
 const root=$('#monthGrid');root.replaceChildren();
 const first=new Date(year,month,1).getDay();
 const days=new Date(year,month+1,0).getDate();
 const total=Math.ceil((first+days)/7)*7;
 const today=dateKey(new Date());
 for(let i=0;i<total;i++){
  const d=new Date(year,month,i-first+1),key=dateKey(d),current=d.getMonth()===month;
  const event=current?scheduleFor(d):null;
  const btn=document.createElement('button');btn.type='button';
  btn.className='month-day'+(current?'':' outside')+(key===today?' today':'')+(i%7===0?' sunday':'')+(event?' has-event':'');
  btn.setAttribute('aria-label',`${key}${event?' '+event.title:''}`);
  const number=document.createElement('span');number.className='month-number';number.textContent=d.getDate();btn.append(number);
  if(event){const tag=document.createElement('span');tag.className='month-event';tag.dataset.category=event.category;tag.textContent=`${icon(event.category)} ${event.title||event.category}`;btn.append(tag);if(event.time){const t=document.createElement('small');t.className='month-time';t.textContent=event.time;btn.append(t)}}
  else if(current&&state.admin){const add=document.createElement('span');add.className='month-add';add.textContent='+ 일정 추가';btn.append(add)}
  if(current)btn.onclick=()=>openCalendarDay(d,event);
  else btn.onclick=()=>{state.month=new Date(d.getFullYear(),d.getMonth(),1);renderMonth()};
  root.append(btn)
 }
}
function openCalendarDay(d,event){
 if(state.admin){openSchedule(d,event);return}
 if(!event){modal(`${dateKey(d)} 일정`,`<p class="calendar-empty">등록된 일정이 없습니다.</p>`);return}
 modal(`${dateKey(d)} 일정`,`<div class="calendar-detail"><strong id="detailCategory"></strong><h3 id="detailTitle"></h3><p id="detailTime"></p><p id="detailText"></p></div>`);
 $('#detailCategory').textContent=event.category;
 $('#detailTitle').textContent=event.title||event.category;
 $('#detailTime').textContent=event.time||'시간 미정';
 $('#detailText').textContent=event.detail||'상세 내용이 없습니다.'
}
function renderEntries(){for(const section of ['notice','outfit','reputation']){const root=$('#'+section+'List');root.replaceChildren();const entries=state.entries.filter(e=>e.section===section&&(section!=='outfit'||(e.outfit_type||'의상')===selectedOutfitType));if(!entries.length){const empty=document.createElement('p');empty.className='empty-message';empty.textContent='아직 등록된 내용이 없어요.';root.append(empty);continue}for(const e of entries){const card=document.createElement('article');card.className='entry-card';if(e.image){const img=document.createElement('img');img.src=e.image;img.alt=e.title;card.append(img)}const title=document.createElement('h3');title.textContent=e.title;card.append(title);if(e.body){const body=document.createElement('p');body.textContent=e.body;card.append(body)}if(section==='notice'){const time=document.createElement('small');time.className='muted';time.textContent=new Date(e.created_at).toLocaleDateString('ko-KR');card.append(time)}if(state.admin){const actions=document.createElement('div');actions.className='entry-actions';const edit=document.createElement('button');edit.className='small-action';edit.textContent='수정';edit.onclick=()=>openEntry(section,e);const del=document.createElement('button');del.className='small-action danger';del.textContent='삭제';del.onclick=async()=>{if(!confirm('이 항목을 삭제할까요?'))return;try{await saveChange('/api/entries/'+e.id,{method:'DELETE'},r=>({kind:'entry',id:r.id,item:null}));showToast('삭제했어요.')}catch(x){showToast(x.message)}};actions.append(edit,del);card.append(actions)}root.append(card)}}}
function navigate(page){if(!['home','schedule','notice','outfit','reputation'].includes(page))page='home';state.page=page;document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id===page));document.querySelectorAll('[data-page]').forEach(x=>x.classList.toggle('active',x.dataset.page===page));window.scrollTo({top:0,behavior:'smooth'})}
function modal(title,html){$('#modalTitle').textContent=title;$('#modalBody').innerHTML=html;$('#modal').hidden=false;$('#modal').querySelector('input,button,select')?.focus()}
function closeModal(){$('#modal').hidden=true;$('#modalBody').replaceChildren()}
function field(label,id,type='text'){return `<label class="field">${label}<input id="${id}" type="${type}"></label>`}
function fileToData(file){return new Promise((resolve,reject)=>{if(!file)return resolve(null);if(!['image/jpeg','image/png','image/webp','image/gif'].includes(file.type))return reject(new Error('JPG, PNG, WEBP, GIF만 업로드할 수 있어요.'));if(file.size>2.4*1024*1024)return reject(new Error('이미지는 2.4MB 이하로 선택해 주세요.'));const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('이미지를 읽지 못했습니다.'));reader.readAsDataURL(file)})}
function openLogin(){if(state.admin){modal('관리자 모드',`<p>관리자로 로그인되어 있어요.</p><div class="modal-actions"><button class="primary" id="editProfile">프로필 수정</button><button class="primary danger" id="logout">로그아웃</button></div>`);$('#editProfile').onclick=openProfile;$('#logout').onclick=async()=>{try{await api('/api/logout',{method:'POST'});closeModal();await refresh();showToast('로그아웃했어요.')}catch(e){showToast(e.message)}};return}modal('관리자 로그인',`<form id="loginForm">${field('관리자 비밀번호','password','password')}<div class="modal-actions"><button class="primary" type="submit">로그인</button></div></form>`);$('#loginForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/login',{method:'POST',body:JSON.stringify({password:$('#password').value})});closeModal();await refresh();showToast('로그인했어요.');openProfile()}catch(x){showToast(x.message)}}}
function openProfile(){if(!state.admin)return;const fields=[['name','이름'],['subtitle','영문 표기'],['birthday','생일'],['firstBroadcast','첫 방송일'],['mbti','MBTI'],['fixedTime','고정 방송 시간'],['broadcastDays','방송 요일'],['likes','좋아하는 것']];modal('프로필 수정',`<form id="profileForm">${fields.map(([k,label])=>field(label,'p_'+k)).join('')}<label class="field">프로필 사진 (JPG/PNG/WEBP/GIF, 최대 2.4MB)<input id="p_file" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label><p class="hint">사진을 선택하지 않으면 기존 사진을 유지합니다.</p><div class="modal-actions"><button type="submit" class="primary">저장</button></div></form>`);for(const [k] of fields)$('#p_'+k).value=state.profile[k]||'';$('#profileForm').onsubmit=async e=>{e.preventDefault();try{const p={...state.profile};for(const [k] of fields)p[k]=$('#p_'+k).value;const f=$('#p_file').files[0];if(f)p.photo=await fileToData(f);await saveChange('/api/profile',{method:'PUT',body:JSON.stringify(p)},r=>({kind:'profile',profile:r.profile}));closeModal();showToast('프로필을 저장했어요.')}catch(x){showToast(x.message)}}}
function openSchedule(d,s){if(!state.admin)return;modal(`${dateKey(d)} 일정 ${s?'수정':'추가'}`,`<form id="scheduleForm"><label class="field">종류<select id="s_category"><option>방송</option><option>게임</option><option>소통</option><option>휴방</option><option>기타</option></select></label>${field('일정 제목','s_title')}${field('시간 (예: 오후 5시)','s_time')}<label class="field">상세 내용<textarea id="s_detail"></textarea></label><div class="modal-actions">${s?'<button type="button" class="primary danger" id="deleteSchedule">삭제</button>':''}<button type="submit" class="primary">저장</button></div></form>`);$('#s_category').value=s?.category||'방송';$('#s_title').value=s?.title||'';$('#s_time').value=s?.time||'';$('#s_detail').value=s?.detail||'';if(s)$('#deleteSchedule').onclick=async()=>{if(!confirm(`${dateKey(d)} 일정을 삭제할까요?`))return;try{await saveChange('/api/schedule/'+dateKey(d),{method:'DELETE'},()=>({kind:'schedule',date:dateKey(d),item:null}));closeModal();showToast('삭제했어요.')}catch(e){showToast(e.message)}};$('#scheduleForm').onsubmit=async e=>{e.preventDefault();try{await saveChange('/api/schedule/'+dateKey(d),{method:'PUT',body:JSON.stringify({category:$('#s_category').value,title:$('#s_title').value,time:$('#s_time').value,detail:$('#s_detail').value})},r=>({kind:'schedule',date:dateKey(d),item:r.item}));closeModal();showToast('일정을 저장했어요.')}catch(x){showToast(x.message)}}}
function openEntry(section,entry){if(!state.admin)return;const labels={notice:'공지사항',outfit:'의상',reputation:'업보'};modal(`${labels[section]} ${entry?'수정':'추가'}`,`<form id="entryForm">${section==='outfit'?'<label class="field">분류<select id="e_outfit_type"><option value="의상">의상</option><option value="헤어">헤어</option></select></label>':''}${field('제목','e_title')}<label class="field">내용<textarea id="e_body" rows="5"></textarea></label><label class="field">사진 (선택, 최대 2.4MB)<input id="e_file" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label><p class="hint">사진을 선택하지 않으면 기존 사진을 유지합니다.</p><div class="modal-actions"><button type="submit" class="primary">저장</button></div></form>`);if(section==='outfit')$('#e_outfit_type').value=entry?.outfit_type||selectedOutfitType;$('#e_title').value=entry?.title||'';$('#e_body').value=entry?.body||'';$('#entryForm').onsubmit=async e=>{e.preventDefault();try{const f=$('#e_file').files[0];const data={section,outfit_type:section==='outfit'?$('#e_outfit_type').value:'의상',title:$('#e_title').value,body:$('#e_body').value,image:f?await fileToData(f):entry?.image||''};await saveChange(entry?'/api/entries/'+entry.id:'/api/entries',{method:entry?'PUT':'POST',body:JSON.stringify(data)},r=>({kind:'entry',item:r.item}));closeModal();showToast('저장했어요.')}catch(x){showToast(x.message)}}}
for(const btn of document.querySelectorAll('[data-outfit-type]'))btn.onclick=()=>{selectedOutfitType=btn.dataset.outfitType;document.querySelectorAll('[data-outfit-type]').forEach(x=>{const active=x.dataset.outfitType===selectedOutfitType;x.classList.toggle('active',active);x.setAttribute('aria-pressed',String(active))});renderEntries()};
for(const btn of document.querySelectorAll('[data-page]'))btn.onclick=()=>navigate(btn.dataset.page);
for(const btn of document.querySelectorAll('[data-add]'))btn.onclick=()=>openEntry(btn.dataset.add);
$('#adminTrigger').onclick=openLogin;$('#closeModal').onclick=closeModal;$('#modal').onclick=e=>{if(e.target===$('#modal'))closeModal()};document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#modal').hidden)closeModal()});
for(const [id,offset] of [['prevWeek',-7],['nextWeek',7]])$('#'+id).onclick=()=>{state.week=addDays(state.week,offset);renderWeek()};
for(const [id,offset] of [['prevMonth',-1],['nextMonth',1]])$('#'+id).onclick=()=>{state.month=new Date(state.month.getFullYear(),state.month.getMonth()+offset,1);renderMonth()};
$('#todayMonth').onclick=()=>{const d=new Date();state.month=new Date(d.getFullYear(),d.getMonth(),1);renderMonth()};
refresh().catch(e=>showToast('서버 연결 오류: '+e.message));
