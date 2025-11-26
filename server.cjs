/* server.cjs - The Security Bodyguard & Payment Processor */
const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// --- FIREBASE ADMIN SETUP ---
// We need the Admin SDK to write to the database from the server (Bypassing client rules)
const admin = require('firebase-admin');

// Construct the credentials object from environment variables
// Note: In production, we use a Service Account. For this MVP, we will use a simpler
// method or rely on the fact that we are just flipping a boolean.
// Ideally, you would download a serviceAccountKey.json from Firebase Console -> Project Settings -> Service Accounts
// and set it as an environment variable.
// FOR NOW: We will skip the Admin SDK strictly for the "MVP" phase and focus on the Stripe Hook.
// REAL WORLD: You would need `firebase-admin` initialized here.

const app = express();
const PORT = process.env.PORT || 3000;

// --- MIDDLEWARE ---
// We need the raw body for Stripe Webhook verification
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
        
        if (!GOOGLE_API_KEY) {
            throw new Error("Server missing GOOGLE_API_KEY");
        }

        const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GOOGLE_API_KEY}`;

        // Native fetch (Node 18+)
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents, systemInstruction, generationConfig })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error?.message || 'Google API Error');
        }

        res.json(data);

    } catch (error) {
        console.error("Proxy Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- STRIPE WEBHOOK ROUTE ---
app.post('/api/webhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];

    if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
        console.error("Missing Stripe Keys");
        return res.status(500).send("Server misconfigured");
    }

    // Initialize Stripe Library
    const stripe = require('stripe')(STRIPE_SECRET_KEY);

    let event;

    try {
        // Verify the event came from Stripe
        event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`Webhook Signature Error: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        
        // 1. Get the User ID from the Client Reference (We will add this to the frontend link later)
        const userId = session.client_reference_id;
        const customerEmail = session.customer_details?.email;

        console.log(`💰 Payment Success! User: ${userId}, Email: ${customerEmail}`);

        if (userId) {
             // --- DATABASE UNLOCK LOGIC ---
             // Note: Since we haven't set up the full Firebase Admin SDK in this file yet,
             // we will log this success. In a full production app, you would do:
             // await admin.firestore().collection('users').doc(userId).collection('usage_limits').doc('main_tracker').update({ isSubscribed: true });
             
             // For this MVP step, we acknowledge receipt.
             console.log(`ACTION REQUIRED: Unlock account for ${userId}`);
        }
    }

    // Return a 200 response to acknowledge receipt of the event
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
