// FIX: Must load .env before any other require that reads process.env
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const shopifyService = require('./services/shopify');
const { handleOrderCreate, handleOrderUpdate } = require('./controllers/webhooks');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Initialize Shopify service
try {
  shopifyService.initializeClient();
  console.log('✅ Shopify service initialized');
} catch (error) {
  console.error('❌ Failed to initialize Shopify service:', error.message);
  process.exit(1); // Can't run without a valid config
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    shop: process.env.SHOPIFY_SHOP,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    node: process.version,
  });
});

// Simple ping endpoint for keep-alive
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// Status page with auto-refresh
app.get('/status', (req, res) => {
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <title>Shopify Payment Capturer - Status</title>
    <meta http-equiv="refresh" content="300">
    <style>
      body { font-family: Arial, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; }
      .status { padding: 15px; border-radius: 5px; margin: 20px 0; }
      .up { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
      .info { background: #d1ecf1; color: #0c5460; border: 1px solid #bee5eb; }
      h1 { color: #333; }
      .stats { background: #f8f9fa; padding: 15px; border-radius: 5px; }
    </style>
  </head>
  <body>
    <h1>🛍️ Shopify Payment Capturer</h1>
    <div class="status up">
      <h2>✅ Online - ${new Date().toISOString()}</h2>
      <p>Server is running and accepting webhooks</p>
    </div>
    <div class="status info">
      <h3>📊 System Information</h3>
      <div class="stats">
        <p><strong>Uptime:</strong> ${Math.floor(process.uptime())} seconds</p>
        <p><strong>Node Version:</strong> ${process.version}</p>
        <p><strong>Shop:</strong> ${process.env.SHOPIFY_SHOP || 'Not configured'}</p>
        <p><strong>Environment:</strong> ${process.env.NODE_ENV || 'development'}</p>
        <p><strong>Port:</strong> ${PORT}</p>
      </div>
    </div>
    <div class="status info">
      <h3>🔗 Useful Links</h3>
      <ul>
        <li><a href="/health">Health Check (JSON)</a></li>
        <li><a href="/scheduled-jobs">View Scheduled Jobs</a></li>
        <li><a href="/test/shop">Test Shopify Connection</a></li>
        <li><a href="/test/orders">View Recent Orders</a></li>
      </ul>
    </div>
  </body>
  </html>
  `;
  res.send(html);
});

// Webhook endpoints
app.post('/webhooks/orders/create', handleOrderCreate);
app.post('/webhooks/orders/updated', handleOrderUpdate);

// Test endpoints
app.get('/test/shop', async (req, res) => {
  try {
    await shopifyService.refreshAccessToken();
    res.json({
      shop: process.env.SHOPIFY_SHOP,
      connected: true,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      connected: false,
    });
  }
});

app.get('/test/orders', async (req, res) => {
  try {
    const orders = await shopifyService.getRecentOrders(5);
    res.json({
      count: orders.length,
      orders: orders.map((order) => ({
        id: order.id,
        name: order.name,
        financial_status: order.financial_status,
        note_attributes: order.note_attributes,
        tags: order.tags,
        created_at: order.created_at,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoints
app.get('/debug/order/:orderId', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    console.log(`🔍 Debugging order: ${orderId}`);

    const order = await shopifyService.getOrder(orderId);
    const transactions = await shopifyService.getOrderTransactions(orderId);

    res.json({
      order_id: orderId,
      financial_status: order.financial_status,
      note_attributes: order.note_attributes,
      tags: order.tags,
      line_items: order.line_items?.map((item) => ({
        name: item.name,
        properties: item.properties,
      })),
      transactions: transactions,
      has_authorization: transactions.some((t) => t.kind === 'authorization'),
      has_successful_auth: transactions.some(
        (t) => t.kind === 'authorization' && t.status === 'success'
      ),
    });
  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Manual capture endpoint
app.post('/debug/capture/:orderId', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    console.log(`🔄 Manual capture for order: ${orderId}`);

    const transactions = await shopifyService.getOrderTransactions(orderId);
    const authTransaction = transactions.find(
      (t) => t.kind === 'authorization' && t.status === 'success'
    );

    if (!authTransaction) {
      return res.status(400).json({
        error: 'No authorized transaction found',
        transactions: transactions,
      });
    }

    const result = await shopifyService.capturePayment(
      orderId,
      authTransaction.id
    );

    res.json({
      success: true,
      message: 'Payment captured manually',
      transaction: result,
    });
  } catch (error) {
    console.error('Manual capture error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Scheduled jobs endpoint
app.get('/scheduled-jobs', (req, res) => {
  const jobs = shopifyService.getScheduledJobs();
  res.json({
    count: jobs.length,
    jobs: jobs,
    timestamp: new Date().toISOString(),
  });
});

// Manual schedule endpoint (for testing)
app.post('/test-schedule/:orderId', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const delay = parseInt(req.query.delay) || 120000; // Default 2 minutes

    console.log(
      `⏰ Manually scheduling capture for order ${orderId} in ${delay}ms`
    );

    const transactions = await shopifyService.getOrderTransactions(orderId);
    const authTransaction = transactions.find(
      (t) => t.kind === 'authorization' && t.status === 'success'
    );

    if (!authTransaction) {
      return res.status(400).json({
        error: 'No authorized transaction found',
        transactions: transactions,
      });
    }

    shopifyService.schedulePaymentCapture(orderId, authTransaction.id, delay);

    const jobs = shopifyService.getScheduledJobs();

    res.json({
      success: true,
      message: `Payment capture scheduled for order ${orderId}`,
      scheduledJobs: jobs,
      captureIn: `${delay}ms`,
    });
  } catch (error) {
    console.error('Schedule test error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start the scheduler
shopifyService.startScheduler();

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(
    `🏪 Shop: ${process.env.SHOPIFY_SHOP || 'Not configured'}`
  );
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📡 Health: http://localhost:${PORT}/health`);
  console.log(`📊 Status: http://localhost:${PORT}/status`);

  // Verify token on startup
  shopifyService.refreshAccessToken().catch((error) => {
    console.error(
      'Failed to validate access token on startup:',
      error.message
    );
  });
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  process.exit(0);
});

module.exports = app;
