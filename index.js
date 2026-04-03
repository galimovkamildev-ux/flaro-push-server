const admin   = require("firebase-admin");
const express = require("express");

// ── Firebase инициализация ────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  }),
});

const db  = admin.firestore();
const app = express();
app.use(express.json());

// ── Получить FCM токен пользователя ───────────────────────
async function getFcmToken(userId) {
  try {
    const doc = await db.collection("users").doc(userId).get();
    const token = doc.exists ? (doc.data().fcmToken || null) : null;
    console.log(`[TOKEN] userId=${userId} -> ${token ? "найден" : "не найден"}`);
    return token;
  } catch (e) {
    console.error(`[TOKEN ERROR] ${e.message}`);
    return null;
  }
}

// ── Отправить push уведомление ────────────────────────────
async function sendPush(token, title, body, data = {}) {
  if (!token) {
    console.log(`[НЕТ ТОКЕНА] title=${title}`);
    return;
  }
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
    console.log(`[OK] Push отправлен: ${title} -> ${body}`);
  } catch (e) {
    console.error(`[PUSH ERROR] ${e.message}`);
  }
}

// ── Слушатель: СООБЩЕНИЯ ──────────────────────────────────
let lastMsgTimestamps = {};

function watchMessages() {
  console.log("[СТАРТ] Слушаем сообщения...");
  db.collectionGroup("messages").onSnapshot(async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type !== "added") continue;

      const msg      = change.doc.data();
      const senderId = msg.senderId;
      if (!senderId) continue;

      // Антидубль по id сообщения
      if (lastMsgTimestamps[change.doc.id]) continue;
      lastMsgTimestamps[change.doc.id] = true;

      // Не отправляем если сообщение старше 30 секунд
      const age = Date.now() - (msg.timestamp || 0);
      if (age > 30000) continue;

      const chatPath = change.doc.ref.parent.parent?.id;
      if (!chatPath) continue;

      const parts      = chatPath.split("_");
      if (parts.length !== 2) continue;
      const receiverId = parts[0] === senderId ? parts[1] : parts[0];

      const senderDoc  = await db.collection("users").doc(senderId).get();
      const senderName = senderDoc.exists ? (senderDoc.data().name || "Кто-то") : "Кто-то";

      console.log(`[СООБЩЕНИЕ] от ${senderName} -> ${receiverId}`);
      const token = await getFcmToken(receiverId);
      await sendPush(
        token,
        senderName,
        msg.imageUrl ? "Отправил(а) фото 📷" : (msg.text || "Новое сообщение"),
        { type: "message", senderId, chatId: chatPath }
      );
    }
  }, (err) => {
    console.error(`[ОШИБКА] слушатель сообщений: ${err.message}`);
    setTimeout(watchMessages, 5000);
  });
}

// ── Слушатель: МЭТЧИ ─────────────────────────────────────
let knownMatches       = new Set();
let matchesInitialized = false;

function watchMatches() {
  console.log("[СТАРТ] Слушаем мэтчи...");
  db.collection("matches").onSnapshot(async (snapshot) => {
    if (!matchesInitialized) {
      snapshot.docs.forEach(doc => knownMatches.add(doc.id));
      matchesInitialized = true;
      console.log(`[МЭТЧИ] загружено ${knownMatches.size} существующих`);
      return;
    }
    for (const change of snapshot.docChanges()) {
      if (change.type !== "added") continue;
      if (knownMatches.has(change.doc.id)) continue;
      knownMatches.add(change.doc.id);

      const data = change.doc.data();
      const uid1 = data.user1;
      const uid2 = data.user2;
      if (!uid1 || !uid2) continue;

      const [doc1, doc2] = await Promise.all([
        db.collection("users").doc(uid1).get(),
        db.collection("users").doc(uid2).get()
      ]);
      const name1 = doc1.exists ? (doc1.data().name || "Кто-то") : "Кто-то";
      const name2 = doc2.exists ? (doc2.data().name || "Кто-то") : "Кто-то";

      console.log(`[МЭТЧ] ${name1} + ${name2}`);
      const [token1, token2] = await Promise.all([
        getFcmToken(uid1),
        getFcmToken(uid2)
      ]);
      await sendPush(
        token1,
        "🎉 Новый мэтч!",
        `Вы понравились друг другу с ${name2}!`,
        { type: "match", matchedUserId: uid2 }
      );
      await sendPush(
        token2,
        "🎉 Новый мэтч!",
        `Вы понравились друг другу с ${name1}!`,
        { type: "match", matchedUserId: uid1 }
      );
    }
  }, (err) => {
    console.error(`[ОШИБКА] слушатель мэтчей: ${err.message}`);
    setTimeout(() => { matchesInitialized = false; watchMatches(); }, 5000);
  });
}

// ── Слушатель: ЛАЙКИ ─────────────────────────────────────
let knownLikes       = new Set();
let likesInitialized = false;

function watchLikes() {
  console.log("[СТАРТ] Слушаем лайки...");
  db.collectionGroup("likes").onSnapshot(async (snapshot) => {
    if (!likesInitialized) {
      snapshot.docs.forEach(doc => knownLikes.add(doc.ref.path));
      likesInitialized = true;
      console.log(`[ЛАЙКИ] загружено ${knownLikes.size} существующих`);
      return;
    }
    for (const change of snapshot.docChanges()) {
      if (change.type !== "added") continue;
      const path = change.doc.ref.path;
      if (knownLikes.has(path)) continue;
      knownLikes.add(path);

      // path = "users/{fromUserId}/likes/{toUserId}"
      const parts = path.split("/");
      if (parts.length < 4) continue;
      const fromUserId = parts[1];
      const toUserId   = parts[3];

      const fromDoc  = await db.collection("users").doc(fromUserId).get();
      const fromName = fromDoc.exists ? (fromDoc.data().name || "Кто-то") : "Кто-то";

      console.log(`[ЛАЙК] от ${fromName} -> ${toUserId}`);
      const token = await getFcmToken(toUserId);
      await sendPush(
        token,
        "❤️ Новый лайк!",
        `${fromName} лайкнул(а) тебя!`,
        { type: "like", fromUserId }
      );
    }
  }, (err) => {
    console.error(`[ОШИБКА] слушатель лайков: ${err.message}`);
    setTimeout(() => { likesInitialized = false; watchLikes(); }, 5000);
  });
}

// ── Health check ──────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status:  "ok",
    service: "Flaro Push Server",
    uptime:  Math.floor(process.uptime()) + "s"
  });
});

// ── Keep-alive для Render (не засыпает) ───────────────────
// Render бесплатный план засыпает через 15 мин — пингуем сами себя
const RENDER_URL = process.env.RENDER_URL; // вставишь после деплоя
if (RENDER_URL) {
  setInterval(async () => {
    try {
      await fetch(RENDER_URL);
      console.log("[PING] Keep-alive ok");
    } catch (e) {
      console.error("[PING ERROR]", e.message);
    }
  }, 10 * 60 * 1000); // каждые 10 минут
}

// ── Запуск ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[СЕРВЕР] Flaro Push Server запущен на порту ${PORT}`);
  watchMessages();
  watchMatches();
  watchLikes();
});
