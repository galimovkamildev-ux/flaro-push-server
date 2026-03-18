const express = require("express");
const admin   = require("firebase-admin");

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

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db  = admin.firestore();
const app = express();
app.use(express.json());

async function getFcmToken(userId) {
  try {
    const doc = await db.collection("users").doc(userId).get();
    const token = doc.exists ? (doc.data().fcmToken || null) : null;
    console.log(`[TOKEN] userId=${userId} -> ${token ? "FOUND" : "NULL"}`);
    return token;
  } catch(e) {
    console.error(`[TOKEN ERROR] ${e.message}`);
    return null;
  }
}

async function sendPush(token, title, body, data = {}) {
  if (!token) {
    console.log(`[NO TOKEN] title=${title}`);
    return;
  }
  try {
    await admin.messaging().send({
      token,
      notification: { title, body },
      data,
      android: { priority: "high", notification: { sound: "default", channelId: "flaro_main" } }
    });
    console.log(`[PUSH OK] ${title} -> ${body}`);
  } catch (e) {
    console.error(`[PUSH ERROR] ${e.message}`);
  }
}

let lastMsgTimestamps = {};

function watchMessages() {
  console.log("[START] Watching messages...");
  db.collectionGroup("messages").onSnapshot(async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type !== "added") continue;

      const msg      = change.doc.data();
      const chatPath = change.doc.ref.parent.parent.id;
      const msgTime  = msg.timestamp || 0;

      const lastTime = lastMsgTimestamps[chatPath] || (Date.now() - 10000);
      if (msgTime < lastTime) continue;
      lastMsgTimestamps[chatPath] = msgTime;

      const senderId = msg.senderId;
      if (!senderId) continue;

      const parts = chatPath.split("_");
      if (parts.length !== 2) continue;
      const receiverId = parts[0] === senderId ? parts[1] : parts[0];

      const senderDoc  = await db.collection("users").doc(senderId).get();
      const senderName = senderDoc.exists ? (senderDoc.data().name || "Someone") : "Someone";

      console.log(`[MSG] from=${senderId}(${senderName}) to=${receiverId} chat=${chatPath}`);
      const token = await getFcmToken(receiverId);
      await sendPush(token, senderName, msg.text || "New message",
        { type: "message", senderId, chatId: chatPath });
    }
  }, (err) => {
    console.error(`[ERROR] messages listener: ${err.message}`);
    setTimeout(watchMessages, 5000);
  });
}

let knownMatches       = new Set();
let matchesInitialized = false;

function watchMatches() {
  console.log("[START] Watching matches...");
  db.collection("matches").onSnapshot(async (snapshot) => {
    if (!matchesInitialized) {
      snapshot.docs.forEach(doc => knownMatches.add(doc.id));
      matchesInitialized = true;
      console.log(`[MATCHES] loaded ${knownMatches.size} existing`);
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
      const name1 = doc1.exists ? (doc1.data().name || "Someone") : "Someone";
      const name2 = doc2.exists ? (doc2.data().name || "Someone") : "Someone";

      console.log(`[MATCH] ${name1} + ${name2}`);
      const [token1, token2] = await Promise.all([getFcmToken(uid1), getFcmToken(uid2)]);
      await sendPush(token1, "New match!", `You matched with ${name2}!`, { type: "match", matchedUserId: uid2 });
      await sendPush(token2, "New match!", `You matched with ${name1}!`, { type: "match", matchedUserId: uid1 });
    }
  }, (err) => {
    console.error(`[ERROR] matches listener: ${err.message}`);
    setTimeout(() => { matchesInitialized = false; watchMatches(); }, 5000);
  });
}

let knownLikes       = new Set();
let likesInitialized = false;

function watchLikes() {
  console.log("[START] Watching likes...");
  db.collectionGroup("likes").onSnapshot(async (snapshot) => {
    if (!likesInitialized) {
      snapshot.docs.forEach(doc => knownLikes.add(doc.ref.path));
      likesInitialized = true;
      console.log(`[LIKES] loaded ${knownLikes.size} existing`);
      return;
    }
    for (const change of snapshot.docChanges()) {
      if (change.type !== "added") continue;
      const path = change.doc.ref.path;
      if (knownLikes.has(path)) continue;
      knownLikes.add(path);

      const parts = path.split("/");
      if (parts.length < 4) continue;
      const fromUserId = parts[1];
      const toUserId   = parts[3];

      const fromDoc  = await db.collection("users").doc(fromUserId).get();
      const fromName = fromDoc.exists ? (fromDoc.data().name || "Someone") : "Someone";

      console.log(`[LIKE] from=${fromUserId}(${fromName}) to=${toUserId}`);
      const token = await getFcmToken(toUserId);
      await sendPush(token, "New like!", `${fromName} liked you!`, { type: "like", fromUserId });
    }
  }, (err) => {
    console.error(`[ERROR] likes listener: ${err.message}`);
    setTimeout(() => { likesInitialized = false; watchLikes(); }, 5000);
  });
}

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Flaro Push Server", uptime: process.uptime() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SERVER] Flaro Push Server on port ${PORT}`);
  watchMessages();
  watchMatches();
  watchLikes();
});
