import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import { extname, join, resolve, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, randomUUID, timingSafeEqual, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import Busboy from 'busboy';

try { process.loadEnvFile?.('.env'); } catch {}

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const STATIC = join(ROOT, 'static');
const UPLOADS = resolve(process.env.QMR_UPLOAD_DIR || join(ROOT, 'uploads'));
await mkdir(UPLOADS, { recursive: true });

const PORT = Number(process.env.QMR_PORT || 3509);
const HOST = process.env.QMR_HOST || '0.0.0.0';
const DEMO = (process.env.QMR_DEMO_MODE ?? '1') === '1';
const SECRET = process.env.QMR_SECRET_KEY || randomBytes(32).toString('hex');
const MAX_UPLOAD = 10 * 1024 * 1024;
const MIME_EXT = {'application/pdf':'.pdf','image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp'};
const registrationAttempts=new Map();
const RELEASE=process.env.QMR_RELEASE||(()=>{try{return readFileSync(join(ROOT,'.release'),'utf8').trim()}catch{return 'development'}})();

function hashPassword(password) {
  const salt=randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(String(password),salt,64).toString('hex')}`;
}
function verifyPassword(password,stored='') {
  try {
    const [salt,hex]=stored.split(':');
    const expected=Buffer.from(hex,'hex'),actual=scryptSync(String(password),salt,64);
    return expected.length===actual.length&&timingSafeEqual(expected,actual);
  } catch { return false; }
}

const database = new DatabaseSync(process.env.QMR_DB_PATH || join(ROOT, 'qmr.db'));
database.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS audits (
    id TEXT PRIMARY KEY, record_type TEXT NOT NULL, ref_no TEXT NOT NULL, hn TEXT NOT NULL,
    patient_name TEXT, department TEXT, auditor TEXT NOT NULL, status TEXT NOT NULL,
    finding TEXT, issue_text TEXT, scores_json TEXT NOT NULL, annotations_json TEXT NOT NULL,
    total_score INTEGER NOT NULL, max_score INTEGER NOT NULL, percent REAL NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audits_ref ON audits(record_type, ref_no);
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY, audit_id TEXT NOT NULL, original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL, mime_type TEXT, size INTEGER NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY(audit_id) REFERENCES audits(id)
  );
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
    target TEXT, detail TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','auditor','viewer')),
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, last_login TEXT
  );
`);

const userColumns=new Set(database.prepare('PRAGMA table_info(users)').all().map(x=>x.name));
if(!userColumns.has('status'))database.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
if(!userColumns.has('department'))database.exec("ALTER TABLE users ADD COLUMN department TEXT NOT NULL DEFAULT ''");

const bootstrapPassword=process.env.QMR_ADMIN_PASSWORD||(DEMO?'demo':'');
if(bootstrapPassword){
  const existingAdmin=database.prepare("SELECT id FROM users WHERE username='admin'").get();
  const stamp=new Date().toISOString().slice(0,19);
  if(existingAdmin){
    database.prepare("UPDATE users SET password_hash=?,role='admin',active=1,status='active',updated_at=? WHERE id=?").run(hashPassword(bootstrapPassword),stamp,existingAdmin.id);
  }else{
    database.prepare('INSERT INTO users(id,username,display_name,password_hash,role,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),'admin','ผู้ดูแลระบบ',hashPassword(bootstrapPassword),'admin',1,stamp,stamp);
  }
}

const now = () => new Date().toISOString().slice(0,19);
const log = (actor, action, target='', detail='') => database.prepare(
  'INSERT INTO activity_log(actor,action,target,detail,created_at) VALUES(?,?,?,?,?)'
).run(actor, action, target, String(detail).slice(0,1000), now());

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(x => {
    const i=x.indexOf('='); return [x.slice(0,i).trim(), decodeURIComponent(x.slice(i+1))];
  }));
}
function signSession(user) {
  const expires = Math.floor(Date.now()/1000) + 8*3600;
  const raw = `${user}|${expires}`;
  return `${raw}|${createHmac('sha256',SECRET).update(raw).digest('hex')}`;
}
function sessionUser(req) {
  try {
    const token=cookies(req).qmr_session || '';
    const parts=token.split('|'); if(parts.length!==3)return null;
    const [user,expires,sig]=parts, raw=`${user}|${expires}`;
    const expected=createHmac('sha256',SECRET).update(raw).digest();
    const actual=Buffer.from(sig,'hex');
    return actual.length===expected.length && timingSafeEqual(actual,expected) && Number(expires)>Date.now()/1000 ? user:null;
  } catch { return null; }
}
function send(res,status,data,headers={}) {
  const body=Buffer.from(typeof data==='string'?data:JSON.stringify(data));
  res.writeHead(status,{'Content-Type':typeof data==='string'?'text/plain; charset=utf-8':'application/json; charset=utf-8','Content-Length':body.length,...headers});
  res.end(body);
}
const ok = (res,data) => send(res,200,data);
const fail = (res,status,detail) => send(res,status,{detail});
function secureHeaders(res) {
  res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('Cache-Control','no-store');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
}
async function jsonBody(req) {
  const chunks=[]; let size=0;
  for await (const chunk of req) { size+=chunk.length; if(size>2*1024*1024)throw Object.assign(new Error('ข้อมูลใหญ่เกินกำหนด'),{status:413}); chunks.push(chunk); }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')}catch{throw Object.assign(new Error('รูปแบบ JSON ไม่ถูกต้อง'),{status:400})}
}
function userRecord(username){return username?database.prepare('SELECT id,username,display_name,department,role,active,status,last_login FROM users WHERE username=?').get(username):null}
function requireUser(req,res){const username=sessionUser(req),u=userRecord(username);if(!u||!u.active){fail(res,401,'กรุณาเข้าสู่ระบบ');return null}return u}
function requireRoles(res,user,roles){if(!roles.includes(user.role)){fail(res,403,'บัญชีนี้ไม่มีสิทธิ์ดำเนินการ');return false}return true}
function safeEqual(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y)}

async function hosQuery(sql,args=[]) {
  if(DEMO || !process.env.HOSXP_PASSWORD)return [];
  const conn=await mysql.createConnection({host:process.env.HOSXP_HOST||'192.168.2.254',port:Number(process.env.HOSXP_PORT||3306),user:process.env.HOSXP_USER||'opd',password:process.env.HOSXP_PASSWORD,database:process.env.HOSXP_DATABASE||'hos',charset:'utf8mb4',connectTimeout:4000});
  try { await conn.query('SET SESSION TRANSACTION READ ONLY'); const [rows]=await conn.execute(sql,args); return rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,v instanceof Date?v.toISOString().slice(0,10):v]))); }
  finally { await conn.end(); }
}

async function optionalHos(label, loader, fallback=[]) {
  try{return await loader()}
  catch(error){console.error(`[HOSxP optional:${label}] ${error.code||'ERROR'}: ${error.message}`);return fallback}
}

async function loadMedications(recordType, ref, fallbackDate='') {
  const key=recordType==='IPD'?'an':'vn';
  const limit=recordType==='IPD'?1000:200;
  try{return await hosQuery(`
    SELECT
      oi.icode,
      COALESCE(
        NULLIF(TRIM(sd.name), ''),
        NULLIF(TRIM(ndi.name), ''),
        NULLIF(TRIM(di.name), ''),
        oi.icode
      ) name,
      COALESCE(NULLIF(TRIM(du.name1), ''), NULLIF(TRIM(oi.drugusage), ''), '-') usage,
      oi.qty,
      oi.unitprice,
      oi.item_type,
      COALESCE(oi.rxdate,oi.vstdate) event_date,
      '' event_time
    FROM opitemrece oi
    LEFT JOIN s_drugitems sd ON sd.icode=oi.icode
    LEFT JOIN nondrugitems ndi ON ndi.icode=oi.icode
    LEFT JOIN drugitems di ON di.icode=oi.icode
    LEFT JOIN drugusage du ON du.code=oi.drugusage
    WHERE oi.${key}=?
    ORDER BY oi.item_no,oi.icode
    LIMIT ${limit}
  `,[ref])}
  catch(error){
    console.error(`[HOSxP medication-date fallback] ${error.code||'ERROR'}: ${error.message}`);
    try{
      const rows=await hosQuery(`SELECT oi.icode,COALESCE(NULLIF(TRIM(sd.name),''),NULLIF(TRIM(ndi.name),''),NULLIF(TRIM(di.name),''),oi.icode) name,COALESCE(NULLIF(TRIM(du.name1),''),NULLIF(TRIM(oi.drugusage),''),'-') usage,oi.qty,oi.unitprice,oi.item_type FROM opitemrece oi LEFT JOIN s_drugitems sd ON sd.icode=oi.icode LEFT JOIN nondrugitems ndi ON ndi.icode=oi.icode LEFT JOIN drugitems di ON di.icode=oi.icode LEFT JOIN drugusage du ON du.code=oi.drugusage WHERE oi.${key}=? LIMIT ${limit}`,[ref]);
      return rows.map(row=>({...row,event_date:fallbackDate,event_time:''}));
    }catch(fallbackError){
      console.error(`[HOSxP medication-name fallback] ${fallbackError.code||'ERROR'}: ${fallbackError.message}`);
      const rows=await hosQuery(`SELECT oi.icode,COALESCE(di.name,oi.icode) name,oi.qty,oi.unitprice FROM opitemrece oi LEFT JOIN drugitems di ON di.icode=oi.icode WHERE oi.${key}=? LIMIT ${limit}`,[ref]);
      return rows.map(row=>({...row,usage:'-',event_date:fallbackDate,event_time:''}));
    }
  }
}

async function loadLabs(vn, limit=500) {
  if(!vn)return [];
  return optionalHos('labs',()=>hosQuery(`
    SELECT
      lh.order_date date,
      lh.order_time event_time,
      li.lab_items_name name,
      COALESCE(NULLIF(TRIM(lo.lab_order_result), ''), 'รอผล') result,
      li.lab_items_normal_value normal_value,
      lo.abnormal_result
    FROM lab_head lh
    JOIN lab_order lo ON lo.lab_order_number=lh.lab_order_number
    JOIN lab_items li ON li.lab_items_code=lo.lab_items_code
    WHERE lh.vn=?
    ORDER BY lh.order_date,lh.order_time,li.display_order
    LIMIT ${limit}
  `,[vn]));
}

const DEMO_CASES=[
 {type:'OPD',ref_no:'690816001234',hn:'00010419',patient_name:'นางสาวอรุณี ใจดี',visit_date:'2026-08-16',department:'อายุรกรรม',doctor_name:'นพ.กิตติพงษ์',status:'รอประเมิน',risk:'ครบถ้วน 78%'},
 {type:'IPD',ref_no:'690001234',hn:'00028741',patient_name:'นายสมชาย พูนสุข',visit_date:'2026-08-12',department:'หอผู้ป่วยชาย',doctor_name:'พญ.ปาริชาติ',status:'กำลังประเมิน',risk:'ควรทบทวน'},
 {type:'OPD',ref_no:'690815004821',hn:'00055329',patient_name:'เด็กชายภูผา สุขสันต์',visit_date:'2026-08-15',department:'กุมารเวชกรรม',doctor_name:'นพ.ธีรภัทร',status:'เสร็จสิ้น',risk:'ผ่านเกณฑ์ 94%'},
 {type:'IPD',ref_no:'690001198',hn:'00031842',patient_name:'นางคำแพง แสนดี',visit_date:'2026-08-09',department:'หอผู้ป่วยหญิง',doctor_name:'พญ.สุภาวดี',status:'รอประเมิน',risk:'เอกสารไม่ครบ'}
];
function demoDetail(kind,ref) {
  const item=DEMO_CASES.find(x=>x.type===kind&&x.ref_no===ref)||DEMO_CASES[0];
  const addDays=(date,days)=>new Date(new Date(`${date}T00:00:00Z`).getTime()+days*86400000).toISOString().slice(0,10);
  const medications=[{name:'Paracetamol 500 mg',usage:'1 เม็ด เมื่อมีไข้ ทุก 6 ชั่วโมง',qty:'10',event_date:item.visit_date},{name:'Amoxicillin 500 mg',usage:'1 แคปซูล วันละ 3 ครั้ง หลังอาหาร',qty:'21',event_date:kind==='IPD'?addDays(item.visit_date,1):item.visit_date}];
  const labs=[{name:'CBC',result:'WBC 8,900 /µL',date:kind==='IPD'?addDays(item.visit_date,2):item.visit_date}];
  const timeline=kind==='IPD'?[{event_date:item.visit_date,event_time:'10:15',title:'รับผู้ป่วยเข้า Admit',detail:item.department},{event_date:addDays(item.visit_date,2),event_time:'09:30',title:'ย้ายเตียง/หอผู้ป่วย',detail:'ติดตามอาการต่อเนื่อง'},{event_date:addDays(item.visit_date,3),event_time:'',title:'จำหน่ายผู้ป่วย',detail:'ระยะเวลานอน 3 วัน'}]:[];
  return {...item,age:'42 ปี',sex:item.patient_name.includes('นาง')?'หญิง':'ชาย',rights:'สิทธิหลักประกันสุขภาพแห่งชาติ',chief_complaint:'ไข้ ไอ มีเสมหะ 2 วันก่อนมาโรงพยาบาล',present_illness:'2 วันก่อนมา มีไข้ต่ำ ไอมีเสมหะ ไม่มีหอบเหนื่อย รับประทานอาหารได้',vitals:{temperature:'37.8',pulse:'92',respiration:'20',bp:'128/76',weight:'58',height:'160'},diagnoses:[{code:'J06.9',name:'Acute upper respiratory infection, unspecified',type:'Principal'}],medications,labs,timeline,admit:kind==='IPD'?{regdate:item.visit_date,dchdate:addDays(item.visit_date,3),los:'3',ward:item.department}:null};
}

async function listCases(url) {
  const q=url.searchParams.get('q')||'', type=url.searchParams.get('record_type')||'ALL', from=url.searchParams.get('date_from')||'', to=url.searchParams.get('date_to')||'';
  if(DEMO || !process.env.HOSXP_PASSWORD){let items=DEMO_CASES.filter(x=>(type==='ALL'||x.type===type)&&(!q||JSON.stringify(x).toLocaleLowerCase().includes(q.toLocaleLowerCase())));return {items,source:'demo',count:items.length}}
  const limit=50,items=[];
  if(type==='ALL'||type==='OPD'){
    const terms=[],args=[]; if(q){terms.push("(p.hn LIKE ? OR CONCAT(p.pname,p.fname,' ',p.lname) LIKE ? OR o.vn LIKE ?)");args.push(`%${q}%`,`%${q}%`,`%${q}%`)} if(from){terms.push('o.vstdate >= ?');args.push(from)} if(to){terms.push('o.vstdate <= ?');args.push(to)}
    const where=terms.join(' AND ')||'o.vstdate >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)';
    items.push(...await hosQuery(`SELECT 'OPD' type,o.vn ref_no,o.hn,CONCAT(p.pname,p.fname,' ',p.lname) patient_name,o.vstdate visit_date,COALESCE(k.department,'OPD') department,COALESCE(d.name,'-') doctor_name FROM ovst o JOIN patient p ON p.hn=o.hn LEFT JOIN doctor d ON d.code=o.doctor LEFT JOIN kskdepartment k ON k.depcode=o.main_dep WHERE ${where} ORDER BY o.vstdate DESC LIMIT ${limit}`,args));
  }
  if(type==='ALL'||type==='IPD'){
    const terms=[],args=[]; if(q){terms.push("(p.hn LIKE ? OR CONCAT(p.pname,p.fname,' ',p.lname) LIKE ? OR i.an LIKE ?)");args.push(`%${q}%`,`%${q}%`,`%${q}%`)} if(from){terms.push('i.regdate >= ?');args.push(from)} if(to){terms.push('i.regdate <= ?');args.push(to)}
    const where=terms.join(' AND ')||'i.regdate >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)';
    items.push(...await hosQuery(`SELECT 'IPD' type,i.an ref_no,i.hn,CONCAT(p.pname,p.fname,' ',p.lname) patient_name,i.regdate visit_date,COALESCE(w.name,'IPD') department,COALESCE(d.name,'-') doctor_name FROM ipt i JOIN patient p ON p.hn=i.hn LEFT JOIN ward w ON w.ward=i.ward LEFT JOIN doctor d ON d.code=i.admdoctor WHERE ${where} ORDER BY i.regdate DESC LIMIT ${limit}`,args));
  }
  return {items,source:'hosxp',count:items.length};
}

async function caseDetail(kind,ref){
  if(DEMO||!process.env.HOSXP_PASSWORD)return demoDetail(kind,ref);
  if(kind==='OPD'){
    const base=await hosQuery(`SELECT 'OPD' type,o.vn ref_no,o.hn,CONCAT(p.pname,p.fname,' ',p.lname) patient_name,TIMESTAMPDIFF(YEAR,p.birthday,CURDATE()) age,p.sex,o.vstdate visit_date,COALESCE(k.department,'OPD') department,COALESCE(d.name,'-') doctor_name,COALESCE(pt.name,'-') rights,os.cc chief_complaint,os.hpi present_illness,os.temperature,os.pulse,os.rr respiration,CONCAT(os.bps,'/',os.bpd) bp,os.bw weight,os.height FROM ovst o JOIN patient p ON p.hn=o.hn LEFT JOIN opdscreen os ON os.vn=o.vn LEFT JOIN doctor d ON d.code=o.doctor LEFT JOIN pttype pt ON pt.pttype=o.pttype LEFT JOIN kskdepartment k ON k.depcode=o.main_dep WHERE o.vn=? LIMIT 1`,[ref]);
    if(!base.length)throw Object.assign(new Error('ไม่พบ VN'),{status:404}); const r=base[0]; r.vitals={temperature:r.temperature,pulse:r.pulse,respiration:r.respiration,bp:r.bp,weight:r.weight,height:r.height}; for(const k of Object.keys(r.vitals))delete r[k];
    r.diagnoses=await hosQuery("SELECT od.icd10 code,COALESCE(ic.name,'') name,od.diagtype type FROM ovstdiag od LEFT JOIN icd101 ic ON ic.code=od.icd10 WHERE od.vn=?",[ref]);
    r.medications=await loadMedications('OPD',ref,r.visit_date);
    r.labs=await loadLabs(ref,200); r.timeline=[]; return r;
  }
  const base=await hosQuery(`SELECT 'IPD' type,i.an ref_no,i.hn,CONCAT(p.pname,p.fname,' ',p.lname) patient_name,TIMESTAMPDIFF(YEAR,p.birthday,CURDATE()) age,p.sex,i.regdate visit_date,COALESCE(w.name,'IPD') department,COALESCE(d.name,'-') doctor_name,COALESCE(pt.name,'-') rights,i.regdate,i.dchdate,DATEDIFF(COALESCE(i.dchdate,CURDATE()),i.regdate) los FROM ipt i JOIN patient p ON p.hn=i.hn LEFT JOIN ward w ON w.ward=i.ward LEFT JOIN doctor d ON d.code=i.admdoctor LEFT JOIN pttype pt ON pt.pttype=i.pttype WHERE i.an=? LIMIT 1`,[ref]);
  if(!base.length)throw Object.assign(new Error('ไม่พบ AN'),{status:404}); const r=base[0];r.admit={regdate:r.regdate,dchdate:r.dchdate,los:r.los};delete r.regdate;delete r.dchdate;delete r.los;Object.assign(r,{chief_complaint:'ดูรายละเอียดจากเอกสาร IPD',present_illness:'',vitals:{},labs:[],timeline:[]});
  const admitVn=(await optionalHos('ipt-vn',()=>hosQuery('SELECT vn FROM ipt WHERE an=? LIMIT 1',[ref])))[0]?.vn||'';
  r.diagnoses=await hosQuery("SELECT id.icd10 code,COALESCE(ic.name,'') name,id.diagtype type FROM iptdiag id LEFT JOIN icd101 ic ON ic.code=id.icd10 WHERE id.an=?",[ref]);
  r.medications=await loadMedications('IPD',ref,r.admit.regdate);
  r.labs=await loadLabs(admitVn);
  r.timeline=await optionalHos('bed-moves',()=>hosQuery(`SELECT bm.movedate event_date,bm.movetime event_time,'ย้ายเตียง/หอผู้ป่วย' title,CONCAT(COALESCE(ow.name,bm.oward,'-'),' เตียง ',COALESCE(bm.obedno,'-'),' → ',COALESCE(nw.name,bm.nward,'-'),' เตียง ',COALESCE(bm.nbedno,'-'),CASE WHEN COALESCE(bm.movereason,'')='' THEN '' ELSE CONCAT(' • ',bm.movereason) END) detail FROM iptbedmove bm LEFT JOIN ward ow ON ow.ward=bm.oward LEFT JOIN ward nw ON nw.ward=bm.nward WHERE bm.an=? ORDER BY bm.movedate,bm.movetime`,[ref]));
  r.timeline.unshift({event_date:r.admit.regdate,event_time:'',title:'รับผู้ป่วยเข้า Admit',detail:r.department});
  if(r.admit.dchdate)r.timeline.push({event_date:r.admit.dchdate,event_time:'',title:'จำหน่ายผู้ป่วย',detail:`ระยะเวลานอน ${r.admit.los} วัน`});
  return r;
}

function staticFile(req,res,path) {
  const relative=path==='/'?'index.html':decodeURIComponent(path.replace(/^\/static\//,''));
  const file=resolve(STATIC,relative); if(!(file===STATIC||file.startsWith(STATIC+sep))||!existsSync(file)||statSync(file).isDirectory())return false;
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
  res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Content-Length':statSync(file).size,'Cache-Control':'no-cache'});createReadStream(file).pipe(res);return true;
}

async function handleUpload(req,res,user,auditId){
  if(!database.prepare('SELECT 1 FROM audits WHERE id=?').get(auditId))return fail(res,404,'กรุณาบันทึกแบบประเมินก่อนแนบไฟล์');
  await new Promise((resolveUpload,reject)=>{
    let result=null;
    const pending=[];
    const bb=Busboy({headers:req.headers,limits:{fileSize:MAX_UPLOAD,files:1}});
    bb.on('file',(name,stream,info)=>{
      if(!MIME_EXT[info.mimeType]){
        stream.resume();
        reject(Object.assign(new Error('รองรับ PDF, JPG, PNG และ WEBP เท่านั้น'),{status:415}));
        return;
      }
      const id=randomUUID(),stored=id+MIME_EXT[info.mimeType],chunks=[];
      let size=0,limited=false;
      stream.on('limit',()=>limited=true);
      stream.on('data',chunk=>{size+=chunk.length;chunks.push(chunk)});
      pending.push(new Promise((done,failed)=>{
        stream.on('end',async()=>{
          try{
            if(limited)throw Object.assign(new Error('ไฟล์ต้องไม่เกิน 10 MB'),{status:413});
            await writeFile(join(UPLOADS,stored),Buffer.concat(chunks));
            database.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?,?)').run(id,auditId,basename(info.filename||'file'),stored,info.mimeType,size,now());
            result={ok:true,id,name:basename(info.filename||'file'),size};
            done();
          }catch(error){failed(error)}
        });
      }));
    });
    bb.on('error',reject);
    bb.on('finish',async()=>{
      try{
        await Promise.all(pending);
        if(!result)throw Object.assign(new Error('ไม่พบไฟล์'),{status:400});
        resolveUpload(result);
      }catch(error){reject(error)}
    });
    req.pipe(bb);
  }).then(result=>{log(user.username,'upload_attachment',auditId,result.name);ok(res,result)}).catch(error=>fail(res,error.status||500,error.message));
}

const server=http.createServer(async(req,res)=>{
  secureHeaders(res);const url=new URL(req.url,`http://${req.headers.host||'localhost'}`),path=url.pathname;
  try{
    if((path==='/'||path.startsWith('/static/'))&&req.method==='GET'){if(staticFile(req,res,path))return;return fail(res,404,'ไม่พบไฟล์')}
    if(path==='/api/version'&&req.method==='GET')return ok(res,{service:'qmr-kss',version:'1.0.0',release:RELEASE,runtime:process.version});
    if(path==='/api/session'&&req.method==='GET'){const u=userRecord(sessionUser(req));return ok(res,{authenticated:!!u?.active,user:u?.username||null,display_name:u?.display_name||null,role:u?.role||null,demo:DEMO})}
    if(path==='/api/login'&&req.method==='POST'){
      const b=await jsonBody(req),u=database.prepare('SELECT * FROM users WHERE username=?').get(String(b.username||'').trim());
      if(!u||!verifyPassword(b.password,u.password_hash))return fail(res,401,'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
      if(!u.active)return fail(res,403,u.status==='pending'?'บัญชีกำลังรอผู้ดูแลระบบอนุมัติ':'บัญชีนี้ถูกระงับการใช้งาน');
      database.prepare('UPDATE users SET last_login=? WHERE id=?').run(now(),u.id);
      const cookie=`qmr_session=${encodeURIComponent(signSession(u.username))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.QMR_SECURE_COOKIE==='1'?'; Secure':''}`;
      log(u.username,'login');return send(res,200,{ok:true,user:u.username,display_name:u.display_name,role:u.role},{'Set-Cookie':cookie});
    }
    if(path==='/api/register'&&req.method==='POST'){
      if(process.env.QMR_ALLOW_REGISTRATION==='0')return fail(res,403,'ระบบปิดรับสมัครสมาชิกชั่วคราว');
      const ip=req.socket.remoteAddress||'unknown',stampMs=Date.now(),recent=(registrationAttempts.get(ip)||[]).filter(x=>stampMs-x<3600000);
      if(recent.length>=5)return fail(res,429,'สมัครสมาชิกเกินจำนวนที่กำหนด กรุณาลองใหม่ภายหลัง');
      recent.push(stampMs);registrationAttempts.set(ip,recent);
      const b=await jsonBody(req),username=String(b.username||'').trim().toLowerCase(),displayName=String(b.display_name||'').trim(),department=String(b.department||'').trim(),password=String(b.password||''),confirm=String(b.password_confirm||'');
      if(!/^[a-z0-9._-]{3,32}$/.test(username))return fail(res,400,'ชื่อผู้ใช้ต้องมี 3–32 ตัว ใช้ a-z, 0-9, จุด ขีดกลาง หรือขีดล่าง');
      if(displayName.length<2)return fail(res,400,'กรุณาระบุชื่อ–สกุล');
      if(department.length<2)return fail(res,400,'กรุณาระบุหน่วยงาน');
      if(password.length<8)return fail(res,400,'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
      if(password!==confirm)return fail(res,400,'ยืนยันรหัสผ่านไม่ตรงกัน');
      if(database.prepare('SELECT 1 FROM users WHERE username=?').get(username))return fail(res,409,'ชื่อผู้ใช้นี้มีอยู่แล้ว');
      const id=randomUUID(),stamp=now();database.prepare("INSERT INTO users(id,username,display_name,password_hash,role,active,created_at,updated_at,status,department) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id,username,displayName,hashPassword(password),'viewer',0,stamp,stamp,'pending',department);log(username,'register_request',username,department);return ok(res,{ok:true,message:'ส่งคำขอสมัครแล้ว กรุณารอผู้ดูแลระบบอนุมัติ'});
    }
    if(path==='/api/logout'&&req.method==='POST'){const u=sessionUser(req)||'unknown';log(u,'logout');return send(res,200,{ok:true},{'Set-Cookie':'qmr_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'})}
    const user=requireUser(req,res);if(!user)return;
    if(path==='/api/health'&&req.method==='GET'){let status=DEMO?'demo':'not_configured';if(!DEMO&&process.env.HOSXP_PASSWORD){try{status=(await hosQuery('SELECT 1 ok'))[0].ok===1?'connected':'error'}catch{status='error'}}return ok(res,{app:'ok',runtime:'node',hosxp:status,host:process.env.HOSXP_HOST||'192.168.2.254',port:PORT})}
    if(path==='/api/dashboard'&&req.method==='GET'){const rows=database.prepare('SELECT status,record_type,percent FROM audits').all(),done=rows.filter(x=>x.status==='completed'),avg=done.length?Math.round(done.reduce((s,x)=>s+x.percent,0)/done.length*10)/10:0;return ok(res,{today:rows.length,completed:done.length,pending:rows.length-done.length,average:avg,opd:rows.filter(x=>x.record_type==='OPD').length,ipd:rows.filter(x=>x.record_type==='IPD').length})}
    if(path==='/api/cases'&&req.method==='GET')return ok(res,await listCases(url));
    let m=path.match(/^\/api\/cases\/(OPD|IPD)\/([^/]+)$/i);if(m&&req.method==='GET'){const kind=m[1].toUpperCase(),ref=decodeURIComponent(m[2]),data=await caseDetail(kind,ref);log(user.username,'view_record',`${kind}:${ref}`,DEMO?'demo':'');return ok(res,data)}
    if(path==='/api/audits'&&req.method==='GET')return ok(res,{items:database.prepare('SELECT id,record_type,ref_no,hn,patient_name,department,auditor,status,total_score,max_score,percent,updated_at FROM audits ORDER BY updated_at DESC LIMIT 500').all()});
    if(path==='/api/audits'&&req.method==='POST'){if(!requireRoles(res,user,['admin','auditor']))return;const b=await jsonBody(req),id=b.id||randomUUID(),states=Object.values(b.scores||{}).flatMap(c=>(c.items||[]).map(i=>i.state)),total=states.filter(x=>x==='1').length,max=states.filter(x=>x==='1'||x==='0').length,percent=max?Math.round(total*1000/max)/10:0,stamp=now(),existing=database.prepare('SELECT created_at FROM audits WHERE id=?').get(id);
      database.prepare(`INSERT OR REPLACE INTO audits(id,record_type,ref_no,hn,patient_name,department,auditor,status,finding,issue_text,scores_json,annotations_json,total_score,max_score,percent,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,b.record_type,b.ref_no,b.hn,b.patient_name||'',b.department||'',user.username,b.status||'draft',b.finding||'no_issue',b.issue_text||'',JSON.stringify(b.scores||{}),JSON.stringify(b.annotations||[]),total,max,percent,existing?.created_at||stamp,stamp);log(user.username,'save_audit',id,`${b.record_type}:${b.ref_no} ${percent}%`);return ok(res,{ok:true,id,total,maximum:max,percent})}
    m=path.match(/^\/api\/audits\/([^/]+)\/attachments$/);if(m&&req.method==='POST'){if(!requireRoles(res,user,['admin','auditor']))return;return await handleUpload(req,res,user,decodeURIComponent(m[1]))}
    m=path.match(/^\/api\/audits\/([^/]+)$/);if(m&&req.method==='GET'){const row=database.prepare('SELECT * FROM audits WHERE id=?').get(decodeURIComponent(m[1]));if(!row)return fail(res,404,'ไม่พบผลประเมิน');row.scores=JSON.parse(row.scores_json);row.annotations=JSON.parse(row.annotations_json);delete row.scores_json;delete row.annotations_json;row.attachments=database.prepare('SELECT id,original_name,mime_type,size,created_at FROM attachments WHERE audit_id=?').all(row.id);return ok(res,row)}
    m=path.match(/^\/api\/attachments\/([^/]+)$/);if(m&&req.method==='GET'){const row=database.prepare('SELECT * FROM attachments WHERE id=?').get(decodeURIComponent(m[1]));if(!row)return fail(res,404,'ไม่พบไฟล์');const file=join(UPLOADS,row.stored_name);res.writeHead(200,{'Content-Type':row.mime_type,'Content-Length':statSync(file).size,'Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(row.original_name)}`});return createReadStream(file).pipe(res)}
    if(path==='/api/users'&&req.method==='GET'){
      if(!requireRoles(res,user,['admin']))return;
      return ok(res,{items:database.prepare("SELECT id,username,CASE WHEN status='pending' THEN '⏳ รออนุมัติ • '||display_name||' • '||department ELSE display_name END display_name,department,role,active,status,created_at,updated_at,last_login FROM users ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,display_name").all()});
    }
    if(path==='/api/users'&&req.method==='POST'){
      if(!requireRoles(res,user,['admin']))return;const b=await jsonBody(req),username=String(b.username||'').trim().toLowerCase(),displayName=String(b.display_name||'').trim(),role=String(b.role||'auditor'),password=String(b.password||'');
      if(!/^[a-z0-9._-]{3,32}$/.test(username))return fail(res,400,'ชื่อผู้ใช้ต้องมี 3–32 ตัว ใช้ a-z, 0-9, จุด ขีดกลาง หรือขีดล่าง');
      if(displayName.length<2)return fail(res,400,'กรุณาระบุชื่อที่แสดง');
      if(password.length<6)return fail(res,400,'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
      if(!['admin','auditor','viewer'].includes(role))return fail(res,400,'บทบาทไม่ถูกต้อง');
      if(database.prepare('SELECT 1 FROM users WHERE username=?').get(username))return fail(res,409,'ชื่อผู้ใช้นี้มีอยู่แล้ว');
      const id=randomUUID(),stamp=now();database.prepare("INSERT INTO users(id,username,display_name,password_hash,role,active,created_at,updated_at,status) VALUES(?,?,?,?,?,?,?,?,?)").run(id,username,displayName,hashPassword(password),role,1,stamp,stamp,'active');log(user.username,'create_user',username,role);return ok(res,{ok:true,id});
    }
    m=path.match(/^\/api\/users\/([^/]+)$/);if(m&&req.method==='PATCH'){
      if(!requireRoles(res,user,['admin']))return;const id=decodeURIComponent(m[1]),target=database.prepare('SELECT * FROM users WHERE id=?').get(id);if(!target)return fail(res,404,'ไม่พบบัญชีสมาชิก');const b=await jsonBody(req),displayName=String(b.display_name??target.display_name).trim(),role=String(b.role??target.role),active=b.active===undefined?target.active:(b.active?1:0),password=String(b.password||''),status=active?(target.status==='pending'?'active':(target.status||'active')):'suspended';
      if(!['admin','auditor','viewer'].includes(role))return fail(res,400,'บทบาทไม่ถูกต้อง');
      if(target.username===user.username&&(!active||role!=='admin'))return fail(res,400,'ไม่สามารถลดสิทธิ์หรือระงับบัญชีของตนเอง');
      if(target.role==='admin'&&(role!=='admin'||!active)){const admins=database.prepare("SELECT COUNT(*) count FROM users WHERE role='admin' AND active=1").get().count;if(admins<=1)return fail(res,400,'ต้องมีผู้ดูแลระบบที่ใช้งานได้อย่างน้อย 1 คน')}
      if(password&&password.length<6)return fail(res,400,'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
      database.prepare('UPDATE users SET display_name=?,role=?,active=?,status=?,password_hash=?,updated_at=? WHERE id=?').run(displayName,role,active,status,password?hashPassword(password):target.password_hash,now(),id);log(user.username,'update_user',target.username,`${role}:${status}${password?':password_reset':''}`);return ok(res,{ok:true});
    }
    if(path==='/api/activity'&&req.method==='GET'){if(!requireRoles(res,user,['admin']))return;return ok(res,{items:database.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT 100').all()})}
    fail(res,404,'ไม่พบเส้นทางที่เรียก');
  }catch(e){console.error(e);if(!res.headersSent)fail(res,e.status||500,e.status?e.message:'ระบบขัดข้อง กรุณาตรวจสอบ server log')}
});

server.listen(PORT,HOST,()=>{
  const mode=DEMO?'DEMO':'HOSxP';
  console.log(`\nQMR KSS (${mode}) พร้อมใช้งาน`);
  console.log(`เครื่องนี้: http://localhost:${PORT}`);
  console.log(`อุปกรณ์ในเครือข่าย: http://<IP-เครื่องนี้>:${PORT}\n`);
});

process.on('SIGINT',()=>server.close(()=>{database.close();process.exit(0)}));
