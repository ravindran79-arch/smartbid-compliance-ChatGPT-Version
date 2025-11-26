/* server.cjs - The Security Bodyguard & Payment Processor */
const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const admin = require('firebase-admin');

// --- 1. INITIALIZE FIREBASE ADMIN (THE ROBOT) ---
// This allows the server to write to the database without permission rules
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase Admin Initialized");
    } catch (error) {
        console.error("❌ Failed to parse FIREBASE_SERVICE_ACCOUNT:", error);
    }
} else {
    console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT not found. Auto-unlock will not work.");
}

const app = express();
const PORT = process.env.PORT || 3000;

// --- MIDDLEWARE ---
// We need the raw body for Stripe verification
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use(cors());

// --- CONSTANTS ---
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// --- AI PROXY ROUTE ---
app.post('/api/analyze', async (req, res) => {
    try {
        const { contents, systemInstruction, generationConfig } = req.body;
        
        if (!GOOGLE_API_KEY) throw new Error("Server missing GOOGLE_API_KEY");

        const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GOOGLE_API_KEY}`;

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents, systemInstruction, generationConfig })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || 'Google API Error');
        res.json(data);

    } catch (error) {
        console.error("Proxy Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- STRIPE WEBHOOK ROUTE (AUTO-UNLOCKER) ---
app.post('/api/webhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];

    if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
        return res.status(500).send("Server misconfigured");
    }

    const stripe = require('stripe')(STRIPE_SECRET_KEY);
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.client_reference_id; // The ID we passed from React
        
        console.log(`💰 Payment Verified for User: ${userId}`);

        if (userId && admin.apps.length) {
            try {
                // 1. Flip the switch in Firestore
                await admin.firestore()
                    .collection('users')
                    .doc(userId)
                    .collection('usage_limits')
                    .doc('main_tracker')
                    .set({ isSubscribed: true }, { merge: true });
                
                console.log(`✅ AUTOMATION SUCCESS: Account unlocked for ${userId}`);
            } catch (dbError) {
                console.error("❌ Database Write Failed:", dbError);
            }
        } else {
             console.error("❌ Cannot unlock: Missing UserID or Admin SDK not ready.");
        }
    }

    res.send();
});

// --- SERVE FRONTEND ---
app.use(express.static(path.join(__dirname, 'dist')));
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running securely on port ${PORT}`);
});
