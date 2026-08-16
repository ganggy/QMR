# QMR KSS — ระบบประเมินคุณภาพเวชระเบียน

เว็บ Node.js สำหรับทีมเวชระเบียน โรงพยาบาลโคกศรีสุพรรณ รองรับ OPD/ER และ IPD เชื่อม HOSxP แบบอ่านอย่างเดียว และเก็บคะแนน ความเห็น ไฮไลต์ และเอกสารแนบไว้ในฐานข้อมูลแยก รองรับคอมพิวเตอร์ โทรศัพท์ และแท็บเล็ต

## เริ่มใช้งาน

1. เปิด PowerShell ที่โฟลเดอร์นี้
2. รัน `Set-ExecutionPolicy -Scope Process Bypass` (หากเครื่องป้องกันการรันสคริปต์)
3. ตรวจสอบว่าติดตั้ง Node.js 22 หรือใหม่กว่าแล้ว
4. รัน `.\start.ps1`
5. เปิด `http://localhost:3509`

สคริปต์จะติดตั้ง dependency, ถามรหัสผ่าน HOSxP และรหัสผู้ดูแลโดยไม่บันทึกลงไฟล์ จากนั้นจะแสดง URL สำหรับโทรศัพท์/แท็บเล็ตให้บนหน้าจอ รหัสผ่าน HOSxP ควรเป็นบัญชีที่มีสิทธิ์ `SELECT` เท่านั้น

### หากเคยพบข้อผิดพลาด `RandomNumberGenerator ... GetBytes`

สคริปต์รุ่นปัจจุบันรองรับ Windows PowerShell 5.1 แล้ว ให้ปิดหน้าต่างเดิม เปิด PowerShell ใหม่ และรัน `.\start.ps1` อีกครั้ง

## เข้าใช้จากโทรศัพท์หรือแท็บเล็ต

- ต่อ Wi-Fi/LAN วงเดียวกับคอมพิวเตอร์ที่รัน QMR
- เปิด URL ที่ `start.ps1` แสดง เช่น `http://192.168.2.20:3509`
- หากเข้าไม่ได้ ให้เปิด Windows Firewall สำหรับ TCP port `3509` เฉพาะ Private/Domain network
- ไม่ควรเปิด port `3509` ออกสู่อินเทอร์เน็ตโดยตรง

## สมาชิกและสิทธิ์

เข้าสู่ระบบด้วยบัญชี `admin` แล้วเลือกเมนู **สมาชิกและสิทธิ์** เพื่อเพิ่มบัญชี รีเซ็ตรหัสผ่าน เปลี่ยนบทบาท หรือระงับบัญชี

ผู้ใช้สามารถกด **สมัครสมาชิกใหม่** ที่หน้าเข้าสู่ระบบ ระบุชื่อ หน่วยงาน ชื่อผู้ใช้ และรหัสผ่าน จากนั้นบัญชีจะอยู่สถานะ **รออนุมัติ** และยังเข้าระบบไม่ได้ ผู้ดูแลต้องเลือกบทบาทแล้วกด **เปิดใช้** ก่อน

- `ผู้ดูแลระบบ` — จัดการสมาชิก ตรวจประเมิน ดูรายงานและ Audit trail
- `ผู้ตรวจประเมิน` — ค้นเวชระเบียน ให้คะแนน บันทึก Comment/Highlight และแนบหลักฐาน
- `ผู้ดูรายงาน` — เปิดดูข้อมูลและรายงานได้ แต่บันทึกหรือแก้ไขผลประเมินไม่ได้

รหัสผ่านถูกจัดเก็บเป็น salted hash และระบบจะไม่ลบบัญชีเพื่อรักษาความเชื่อมโยงกับประวัติ Audit

หากต้องการปิดรับสมัครชั่วคราว ให้ตั้ง environment variable `QMR_ALLOW_REGISTRATION=0` ก่อนเริ่มระบบ

## Deploy ไปยัง Server ด้วย PM2

กำหนด SSH target ตอนเรียกสคริปต์ ส่วนโฟลเดอร์ปลายทางเริ่มต้นคือ `/opt/qrm` และพอร์ตแอปคือ `3509`

จาก Windows ให้รัน:

```powershell
cd D:\QMR
.\deploy-to-server.ps1 -Server 'user@server-ip'
```

สำหรับติดตั้งครั้งแรกหรือแทนระบบเดิม ให้เพิ่ม `-Configure` สคริปต์จะถามรหัส HOSxP และรหัสผู้ดูแลเว็บแบบซ่อนข้อความ แล้วสร้าง `.env` บน server ให้:

```powershell
.\deploy-to-server.ps1 -Server 'user@server-ip' -Configure
```

สคริปต์จะถามรหัส SSH จากหน้าจอโดยตรงและจะไม่บันทึกรหัสไว้ในโปรเจกต์ การ deploy จะทับไฟล์โปรแกรม แต่รักษา `/opt/qrm/.env`, `/opt/qrm/data/` และ `/opt/qrm/logs/`

ครั้งแรกให้แก้ `/opt/qrm/.env` บน server ตาม `.env.production.example` แล้วรัน:

```bash
cd /opt/qrm
chmod 600 .env
pm2 start ecosystem.config.cjs
pm2 save
```

ข้อกำหนด production:

- Node.js 22 ขึ้นไป
- PM2 ทำงานแบบ fork จำนวน 1 instance เท่านั้น เนื่องจากใช้ SQLite
- ฐาน QMR อยู่ที่ `/opt/qrm/data/qmr.db` และไฟล์แนบอยู่ที่ `/opt/qrm/data/uploads`
- สำรอง `/opt/qrm/data/` และ `/opt/qrm/.env` เป็นประจำ
- อนุญาต TCP 3509 เฉพาะ LAN/VPN หรือใช้งานผ่าน HTTPS reverse proxy
- หากใช้ HTTPS ให้เปลี่ยน `QMR_SECURE_COOKIE=1`

## โหมดสาธิต

สำหรับทดสอบ UI โดยไม่ต่อข้อมูลจริง:

```powershell
$env:QMR_DEMO_MODE='1'
$env:QMR_ADMIN_PASSWORD='demo'
$env:QMR_PORT='3509'
npm install
npm start
```

เข้าระบบด้วย `admin / demo` ข้อมูลผู้ป่วยในโหมดนี้เป็นข้อมูลสมมติ

## แนวทางติดตั้งจริง

- ใช้ Node.js 22 ขึ้นไป และวางหลัง HTTPS reverse proxy เมื่อเปิดให้ใช้ข้ามเครือข่าย
- จำกัดการเข้าถึงเฉพาะ LAN โรงพยาบาล/VPN
- เปลี่ยน `QMR_SECRET_KEY` เป็นค่าสุ่มถาวร และสำรอง `qmr.db` กับ `uploads/`
- สร้าง MySQL user เฉพาะระบบนี้ที่อนุญาต `SELECT` เฉพาะตาราง HOSxP ที่จำเป็น
- ไม่เปิดพอร์ต 3509 หรือ MySQL สู่อินเทอร์เน็ต
- ทดสอบชื่อคอลัมน์กับ HOSxP รุ่นที่ใช้งานจริงก่อนเปิด production

แหล่งอ้างอิงใน vault: `HOSxP Knowledge Base/relationships/patient-opd-ipd.md`, `HOSxP Knowledge Base/02-opd/README.md`, `HOSxP Knowledge Base/03-ipd/common-queries.md`, `FDHChecker/atlas/12_MedicalRecord_Audit_Guideline.md`
