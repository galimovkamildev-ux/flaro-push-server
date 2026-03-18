const express = require("express");
const admin   = require("firebase-admin");

// ── Инициализация через переменные окружения ─────────────
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db  = admin.firestore();
const app = express();
app.use(express.json());

// ── Хелпер: получить FCM токен ────────────────────────────
async function getFcmToken(userId) {
  try {
    const doc = await db.collection("users").doc(userId).get();
    return doc.exists ? (doc.data().fcmToken || null) : null;
  } catch { return null; }
}

// ── Хелпер: отправить push ────────────────────────────────
async function sendPush(token, title, body, data = {}) {
  if (!token) return;
  try {
    await admin.messaging().send({
      token,
      notification: { title, body },
      data,
      android: {
        priority: "high",
        notification: { sound: "default", channelId: "flaro_main" }
      }
    });
    console.log(`✅ Push: ${title} → ${body}`);
  } catch (e) {
    console.error("❌ Ошибка push:", e.message);
  }
}

// ── Слушатель: новые СООБЩЕНИЯ ────────────────────────────
let lastMessageTimestamps = {};

async function watchMessages() {
  console.log("👂 Слушаем сообщения...");
  db.collectionGroup("messages").onSnapshot(async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type !== "added") continue;

      const msg      = change.doc.data();
      const chatPath = change.doc.ref.parent.parent.id;
      const msgTime  = msg.timestamp || 0;

      const lastTime = lastMessageTimestamps[chatPath] || Date.now() - 5000;
      if (msgTime < lastTime) continue;
      lastMessageTimestamps[chatPath] = msgTime;

      const senderId = msg.senderId;
      if (!senderId) continue;

      const [uid1, uid2] = chatPath.split("_");
      const receiverId   = uid1 === senderId ? uid2 : uid1;

      const senderDoc  = await db.collection("users").doc(senderId).get();
      const senderName = senderDoc.exists ? (senderDoc.data().name || "Кто-то") : "Кто-то";

      // Всегда шлём push — Android сам не покажет если чат открыт
      const token = await getFcmToken(receiverId);
      await sendPush(token, senderName, msg.text || "Новое сообщение",
        { type: "message", senderId, chatId: chatPath });
    }
  }, (err) => console.error("Ошибка слушателя сообщений:", err));
}

// ── Слушатель: новые МЭТЧИ ───────────────────────────────
let knownMatches       = new Set();
let matchesInitialized = false;

async function watchMatches() {
  console.log("👂 Слушаем мэтчи...");
  db.collection("matches").onSnapshot(async (snapshot) => {
    if (!matchesInitialized) {
      snapshot.docs.forEach(doc => knownMatches.add(doc.id));
      matchesInitialized = true;
      return;
    }
    for (const change of snapshot.docChanges()) {
      if (change.type !== "added") continue;
      if (knownMatches.has(change.doc.id)) continue;
      knownMatches.add(change.doc.id);

      const data = change.doc.data();
      const uid1 = data.user1 || (data.users && data.users[0]);
      const uid2 = data.user2 || (data.users && data.users[1]);
      if (!uid1 || !uid2) continue;

      const [doc1, doc2] = await Promise.all([
        db.collection("users").doc(uid1).get(),
        db.collection("users").doc(uid2).get()
      ]);
      const name1 = doc1.exists ? (doc1.data().name || "Кто-то") : "Кто-то";
      const name2 = doc2.exists ? (doc2.data().name || "Кто-то") : "Кто-то";

      const [token1, token2] = await Promise.all([getFcmToken(uid1), getFcmToken(uid2)]);
      await sendPush(token1, "🎉 Новый мэтч!", `Вы понравились друг другу с ${name2}!`, { type: "match", matchedUserId: uid2 });
      await sendPush(token2, "🎉 Новый мэтч!", `Вы понравились друг другу с ${name1}!`, { type: "match", matchedUserId: uid1 });
    }
  }, (err) => console.error("Ошибка слушателя мэтчей:", err));
}

// ── Слушатель: новые ЛАЙКИ ───────────────────────────────
let knownLikes       = new Set();
let likesInitialized = false;

async function watchLikes() {
  console.log("👂 Слушаем лайки...");
  db.collection("likes").onSnapshot(async (snapshot) => {
    if (!likesInitialized) {
      snapshot.docs.forEach(doc => knownLikes.add(doc.id));
      likesInitialized = true;
      return;
    }
    for (const change of snapshot.docChanges()) {
      if (change.type !== "added") continue;
      if (knownLikes.has(change.doc.id)) continue;
      knownLikes.add(change.doc.id);

      const data       = change.doc.data();
      const fromUserId = data.fromUserId || data.likerId;
      const toUserId   = data.toUserId   || data.likedId;
      if (!fromUserId || !toUserId) continue;

      const fromDoc  = await db.collection("users").doc(fromUserId).get();
      const fromName = fromDoc.exists ? (fromDoc.data().name || "Кто-то") : "Кто-то";

      const token = await getFcmToken(toUserId);
      await sendPush(token, "❤️ Новый лайк!", `${fromName} лайкнул(а) тебя!`, { type: "like", fromUserId });
    }
  }, (err) => console.error("Ошибка слушателя лайков:", err));
}

// ── Health check ──────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Flaro Push Server", uptime: process.uptime() });
});

// ── Запуск ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Flaro Push Server на порту ${PORT}`);
  await watchMessages();
  await watchMatches();
  await watchLikes();
});
