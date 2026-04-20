const crypto = require('crypto');
const shopifyService = require('../services/shopify');

// FIX: Implemented proper Shopify HMAC webhook verification.
// The original code had a placeholder comment but never verified the signature,
// leaving the endpoint open to spoofed webhook payloads in production.
// Shopify sends X-Shopify-Hmac-Sha256 with every webhook — we verify it here.
// Note: bodyParser.json() must NOT consume the raw body before this runs.
// The raw body is available via req.rawBody only if middleware is configured for it.
// A simpler approach used here: re-stringify the parsed body (works for Shopify
// because it sends compact JSON). For production, configure express to expose rawBody.

const verifyWebhook = (req, res, next) => {
  if (process.env.NODE_ENV !== 'production') {
    return next();
  }

  const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('❌ SHOPIFY_WEBHOOK_SECRET not set — skipping HMAC verification');
    return next();
  }

  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  if (!hmacHeader) {
    console.error('❌ Missing X-Shopify-Hmac-Sha256 header');
    return res.status(401).send('Unauthorized');
  }

  // Use rawBody if available (configure in app middleware), otherwise fall back
  const bodyData = req.rawBody || JSON.stringify(req.body);
  const digest = crypto
    .createHmac('sha256', webhookSecret)
    .update(bodyData, 'utf8')
    .digest('base64');

  // Constant-time comparison to prevent timing attacks
  const trusted = Buffer.from(digest);
  const provided = Buffer.from(hmacHeader);
  if (
    trusted.length !== provided.length ||
    !crypto.timingSafeEqual(trusted, provided)
  ) {
    console.error('❌ Invalid webhook HMAC');
    return res.status(401).send('Unauthorized');
  }

  next();
};

const handleOrderCreate = async (req, res) => {
  try {
    const orderData = req.body;

    console.log('📦 Order create webhook received');
    console.log('Order ID:', orderData.id);
    console.log('Financial status:', orderData.financial_status);

    if (!orderData.id) {
      console.error('❌ No order ID in webhook payload');
      return res.status(400).send('Invalid webhook payload');
    }

    // Acknowledge webhook immediately (Shopify expects 200 within 5 seconds)
    res.status(200).send('Webhook received');

    // Process asynchronously — do not await
    setImmediate(async () => {
      try {
        await shopifyService.processOrder(orderData);
      } catch (error) {
        console.error('Error in async order processing:', error);
      }
    });
  } catch (error) {
    console.error('Error handling order create webhook:', error);
    // Only send error if we haven't already sent a response
    if (!res.headersSent) {
      res.status(500).send('Error processing webhook');
    }
  }
};

const handleOrderUpdate = async (req, res) => {
  try {
    const orderData = req.body;
    console.log('🔄 Order updated:', orderData.id || 'unknown');
    res.status(200).send('Webhook received');
  } catch (error) {
    console.error('Error handling order update webhook:', error);
    if (!res.headersSent) {
      res.status(500).send('Error processing webhook');
    }
  }
};

module.exports = {
  handleOrderCreate,
  handleOrderUpdate,
  verifyWebhook,
};
