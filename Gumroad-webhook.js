// api/gumroad-webhook.js  (Vercel serverless function)
//
// SETUP:
//   1. Deploy this as a Vercel function (put in /api/ folder of any Vercel project)
//   2. Add environment variables in Vercel dashboard:
//      FIREBASE_PROJECT_ID      = veloris-64e90
//      FIREBASE_CLIENT_EMAIL    = <from Firebase service account JSON>
//      FIREBASE_PRIVATE_KEY     = <from Firebase service account JSON>
//      GUMROAD_WEBHOOK_SECRET   = <set this in Gumroad > Settings > Advanced > Ping URL secret>
//   3. Paste the deployed URL into Gumroad:
//      Gumroad Dashboard → Settings → Advanced → Ping URL
//      e.g. https://your-vercel-project.vercel.app/api/gumroad-webhook
//
// HOW IT WORKS:
//   Gumroad POSTs to this URL on every sale.
//   We read the buyer email + product permalink, map it to a plan,
//   then write the subscription to Firestore.
//   The desktop app reads Firestore on startup and syncs with local Flask.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore }                  from "firebase-admin/firestore";

// ── Firebase Admin init (lazy, safe for serverless) ──────────────────────────
function getDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      }),
    });
  }
  return getFirestore();
}

// ── Product permalink → plan mapping ─────────────────────────────────────────
// Update these to match your actual Gumroad product permalinks.
const PRODUCT_MAP = {
  "veloris-plus":         { plan: "plus", type: "monthly", days: 31  },
  "veloris-plus-yearly":  { plan: "plus", type: "yearly",  days: 366 },
  "veloris-pro":          { plan: "pro",  type: "monthly", days: 31  },
  "veloris-pro-yearly":   { plan: "pro",  type: "yearly",  days: 366 },
};

function addDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0]; // YYYY-MM-DD
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Parse form-urlencoded body manually (Gumroad sends this format)
  let body = {};
  try {
    if (typeof req.body === "string") {
      const { parse } = await import("querystring");
      body = parse(req.body);
    } else if (req.body && typeof req.body === "object") {
      body = req.body;
    } else {
      // Read raw buffer
      const raw = await new Promise((resolve, reject) => {
        let data = "";
        req.on("data", chunk => { data += chunk; });
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      const { parse } = await import("querystring");
      body = parse(raw);
    }
  } catch (e) {
    console.error("[Veloris Webhook] Body parse error:", e);
    body = {};
  }

  // Optional: verify the webhook secret if you set one in Gumroad
  const secret = process.env.GUMROAD_WEBHOOK_SECRET;
  if (secret && body.webhook_secret !== secret) {
    console.error("[Veloris Webhook] Secret mismatch");
    return res.status(403).json({ error: "Forbidden" });
  }

  const email     = (body.email || "").trim().toLowerCase();
  const permalink = (body.product_permalink || "").trim().toLowerCase();
  const refunded  = body.refunded === "true";

  if (!email) {
    return res.status(400).json({ error: "No email in payload" });
  }

  const mapping = PRODUCT_MAP[permalink];

  if (!mapping) {
    // Unknown product — log it but return 200 so Gumroad doesn't retry
    console.warn(`[Veloris Webhook] Unknown permalink: ${permalink}`);
    return res.status(200).json({ ok: true, note: "Unknown product, ignored" });
  }

  try {
    const db = getDb();

    // Find existing user by email (Firestore users are keyed by Firebase Auth UID,
    // so we query by email field)
    const snapshot = await db
      .collection("users")
      .where("email", "==", email)
      .limit(1)
      .get();

    const plan       = refunded ? "free" : mapping.plan;
    const expiryDate = refunded ? null    : addDays(mapping.days);
    const updateData = {
      plan:             plan,
      subscriptionType: mapping.type,
      expiryDate:       expiryDate,
      updatedAt:        new Date().toISOString(),
      gumroadEmail:     email,
    };

    if (snapshot.empty) {
      // User hasn't signed in to the app yet — store by email so it's ready when they do
      // We use a separate `pending_subscriptions` collection keyed by email
      await db.collection("pending_subscriptions").doc(email).set({
        ...updateData,
        createdAt: new Date().toISOString(),
      });
      console.log(`[Veloris Webhook] Stored pending subscription for ${email}`);
    } else {
      // Update existing user doc
      const userDoc = snapshot.docs[0];
      await userDoc.ref.update(updateData);
      console.log(`[Veloris Webhook] Updated ${email} → ${plan} until ${expiryDate}`);
    }

    return res.status(200).json({ ok: true, plan, expiryDate });

  } catch (err) {
    console.error("[Veloris Webhook] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}

// Disable Vercel's default body parser — we handle form-urlencoded manually above
export const config = {
  api: { bodyParser: false },
};