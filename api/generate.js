// ============================================================================
//  The Billing Coach — Narrative Generator API
//  Serverless function: proxies requests to Anthropic API
//  Runs on Vercel (or any Node.js serverless platform)
// ============================================================================

const { del } = require('@vercel/blob');

// --- Configuration (tune these values) --------------------------------------
const CONFIG = {
  // Which Anthropic model to use. Sonnet 4.6 is the right balance of quality/cost.
  model: 'claude-sonnet-4-6',

  // Max tokens in the response. 16000 is plenty for a narrative set.
  maxTokens: 16000,

  // Rate limit: max requests per IP per window
  rateLimitMax: 20,
  rateLimitWindowMs: 60 * 60 * 1000, // 1 hour

  // Max payload size for non-PDF requests (PDFs now bypass this via Blob storage)
  maxBodyBytes: 8 * 1024 * 1024, // 8MB

  allowedOrigins: [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://atvr.thebillingcoach.com',
    'https://billing-narrative-generator.vercel.app',
  ],

  // If true, allow any vercel.app subdomain (useful for preview deployments)
  allowVercelPreviews: true,
};

// --- In-memory rate limit store ---------------------------------------------
const rateLimitStore = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + CONFIG.rateLimitWindowMs });
    return { allowed: true, remaining: CONFIG.rateLimitMax - 1 };
  }

  if (entry.count >= CONFIG.rateLimitMax) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000),
    };
  }

  entry.count += 1;
  return { allowed: true, remaining: CONFIG.rateLimitMax - entry.count };
}

// --- Origin check -----------------------------------------------------------
function isOriginAllowed(origin) {
  if (!origin) return false;
  if (CONFIG.allowedOrigins.includes(origin)) return true;
  if (CONFIG.allowVercelPreviews && /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)) return true;
  return false;
}

// --- Blob URL resolver ------------------------------------------------------
// Walks the messages array and finds any document blocks that reference a
// PDF in Vercel Blob storage (via pdfBlobUrl). For each one, fetches the PDF,
// converts it to base64, and rewrites the block to the standard Anthropic
// shape. Also collects the URLs so we can delete them after the request
// finishes.
//
// This is what lets the browser upload large PDFs (up to 15 MB) without
// hitting the request body size limit on this endpoint - the PDF travels
// directly browser-to-Blob, and only a small URL string travels here.
async function resolveBlobUrls(messages) {
  const urlsToCleanup = [];

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block && block.type === 'document' && block.source && block.source.pdfBlobUrl) {
        const blobUrl = block.source.pdfBlobUrl;

        // Validate the URL belongs to our Blob store - prevents SSRF attacks
        // where a malicious client tries to make us fetch arbitrary URLs.
        if (!blobUrl.startsWith('https://') || !blobUrl.includes('.public.blob.vercel-storage.com')) {
          throw new Error('Invalid blob URL');
        }

        const blobResponse = await fetch(blobUrl);
        if (!blobResponse.ok) {
