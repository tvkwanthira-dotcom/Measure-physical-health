// สคริปต์แจ้งเตือนดื่มน้ำ -- เวอร์ชันรันผ่าน GitHub Actions (ฟรี ไม่ต้องผูกบัตร)
// แทนที่การใช้ Firebase Cloud Functions (ซึ่งต้องอัปเกรดเป็นแผน Blaze ถึงจะ
// deploy ได้ แม้ปริมาณใช้งานจะไม่มีค่าใช้จ่ายจริงก็ตาม)
//
// GitHub Actions จะรันไฟล์นี้ตามตารางเวลาใน .github/workflows/water-reminder.yml
// (ตั้งไว้ให้ตรงกับ 10:00 / 13:00 / 16:00 / 19:00 เวลาไทยพอดีแล้ว) พอรันแต่ละครั้ง
// สคริปต์นี้จะเช็คทุกคนที่เปิดแจ้งเตือนไว้ ว่าดื่มน้ำวันนี้ตามเป้าหมายทันมั้ย
// ถ้าไม่ทันจะส่ง push แจ้งเตือนไปหา (logic เดียวกับ functions/index.js เป๊ะ
// ต่างแค่วิธี "ปลุก" ให้ทำงานตามเวลา)

const admin = require('firebase-admin');

// service account key ต้องมาจาก GitHub Secret ชื่อ FIREBASE_SERVICE_ACCOUNT
// (ดูวิธีตั้งค่าใน README.md ที่แนบมาด้วยกัน) ห้าม hardcode ค่าไว้ในไฟล์นี้ตรงๆ
// เด็ดขาด เพราะ service account key เปิดสิทธิ์เข้าถึง Firestore ทั้งโปรเจกต์
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccountJson) {
  console.error('ไม่พบ FIREBASE_SERVICE_ACCOUNT ใน environment variable -- ตั้งค่า GitHub Secret ก่อน');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
});

const db = admin.firestore();
const messaging = admin.messaging();

const WATER_GOAL = 8; // ต้องตรงกับจำนวนแก้วน้ำใน community.html (8 ใบ)

// ชม. เวลาไทยที่เช็ค -> สัดส่วนที่ "ควร" ดื่มไปแล้ว ณ เวลานั้น (เผื่อ workflow
// รันคลาดเวลาไปบ้าง ใช้ช่วง ±30 นาทีจับคู่กับจุดที่ใกล้ที่สุดแทนการเป๊ะเป๊ะ)
const PACE_CHECKPOINTS = [
  { hour: 10, expectedRatio: 0.25 }, // สาย -- ควรดื่มไปแล้วอย่างน้อย 2 แก้ว
  { hour: 13, expectedRatio: 0.5 },  // เที่ยง -- อย่างน้อย 4 แก้ว
  { hour: 16, expectedRatio: 0.75 }, // บ่ายแก่ -- อย่างน้อย 6 แก้ว
  { hour: 19, expectedRatio: 1.0 },  // เย็น -- ควรครบ 8 แก้วแล้ว
];

function nowInBangkok() {
  const now = new Date();
  const bangkok = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const yyyy = bangkok.getUTCFullYear();
  const mm = String(bangkok.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(bangkok.getUTCDate()).padStart(2, '0');
  return { dateKey: `${yyyy}-${mm}-${dd}`, hour: bangkok.getUTCHours() };
}

function closestCheckpoint(hour) {
  // เลือกจุดที่ชั่วโมงห่างน้อยที่สุด (กันเวลา GitHub Actions รันคลาดไปบ้าง
  // เช่น cron บอก 03:00 UTC แต่จริงๆ รันตอน 03:04 UTC ก็ยังจับคู่ถูกจุดอยู่)
  let best = null;
  let bestDiff = Infinity;
  for (const cp of PACE_CHECKPOINTS) {
    const diff = Math.abs(cp.hour - hour);
    if (diff < bestDiff) { bestDiff = diff; best = cp; }
  }
  return bestDiff <= 1 ? best : null; // ห่างเกิน 1 ชม. ถือว่าไม่ตรงจุดไหนเลย ข้าม
}

async function main() {
  const { dateKey, hour } = nowInBangkok();
  const checkpoint = closestCheckpoint(hour);
  if (!checkpoint) {
    console.log(`ชม. ${hour}:00 (ไทย) ไม่ตรงจุดเช็คไหนเลย ข้ามรอบนี้`);
    return;
  }

  const usersSnap = await db.collection('users').get();
  const expectedByNow = Math.ceil(WATER_GOAL * checkpoint.expectedRatio);
  const jobs = [];

  usersSnap.forEach((docSnap) => {
    const data = docSnap.data();

    // รองรับทั้งของเก่า (fcmToken เดี่ยว จากตอนที่ยังเก็บได้แค่เครื่องเดียว)
    // และของใหม่ (fcmTokens array รองรับหลายเครื่องพร้อมกัน เช่น คอม + มือถือ)
    // เอามารวมกันแล้วตัดตัวซ้ำทิ้งด้วย Set
    const tokens = [...new Set([
      ...(Array.isArray(data.fcmTokens) ? data.fcmTokens : []),
      ...(data.fcmToken ? [data.fcmToken] : []),
    ])];
    if (tokens.length === 0) return; // ผู้ใช้คนนี้ยังไม่ได้เปิดแจ้งเตือนเครื่องไหนเลย

    const waterToday = data.waterDate === dateKey ? (data.water || 0) : 0;
    if (waterToday >= expectedByNow || waterToday >= WATER_GOAL) return; // ทันเป้า/ครบแล้ว

    const notification = {
      title: '💧 ดื่มน้ำหน่อยนะ',
      body: `วันนี้ดื่มไปแล้ว ${waterToday}/${WATER_GOAL} แก้ว ลองดื่มเพิ่มอีกสักแก้วมั้ย?`,
    };

    // ส่งแยกทีละ token (ไม่ใช่ multicast เดียว) เพื่อให้รู้ชัดว่า "เครื่องไหน"
    // ส่งไม่ผ่านบ้าง จะได้ตัดทิ้งเฉพาะเครื่องนั้นเครื่องเดียว เครื่องอื่นไม่โดนกระทบ
    tokens.forEach((token) => {
      jobs.push(
        messaging
          .send({ token, notification, webpush: { fcmOptions: { link: '/community.html' } } })
          .catch((err) => {
            console.error(`ส่งแจ้งเตือนให้ผู้ใช้ ${docSnap.id} (เครื่อง ...${token.slice(-8)}) ไม่สำเร็จ:`, err.message);
            const deadToken =
              err.code === 'messaging/registration-token-not-registered' ||
              err.code === 'messaging/invalid-registration-token';
            if (!deadToken) return;
            // token หมดอายุ/ถอนการติดตั้งแล้ว -- ลบออกจากทั้งสองฟิลด์ ไม่ต้องรอ error รอบหน้า
            const update = { fcmTokens: admin.firestore.FieldValue.arrayRemove(token) };
            if (data.fcmToken === token) update.fcmToken = null;
            return docSnap.ref.update(update);
          })
      );
    });
  });

  await Promise.all(jobs);
  console.log(`เช็คจุด ${checkpoint.hour}:00 (คาดหวัง ${expectedByNow}/${WATER_GOAL} แก้ว) — ส่งแจ้งเตือนไป ${jobs.length} เครื่อง`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('รันสคริปต์แจ้งเตือนดื่มน้ำไม่สำเร็จ:', err);
    process.exit(1);
  });
