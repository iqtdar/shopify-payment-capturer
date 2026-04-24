require('dotenv').config();
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

// Auth: Dev Dashboard app — client_credentials grant
// Per Shopify docs: POST /admin/oauth/access_token with grant_type=client_credentials
// Tokens expire after 24 hours; we refresh 60 seconds before expiry.
// Env vars required: SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET

const PAY_LATER_DEFAULT_MINUTES = 9360; // 6.5 days — just before Shopify's 7-day auth expiry

class ShopifyService {
  constructor() {
    this.shop = process.env.SHOPIFY_SHOP;
    this.clientId = process.env.SHOPIFY_CLIENT_ID;
    this.clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
    this.apiVersion = process.env.SHOPIFY_API_VERSION || '2024-01';

    this.token = null;
    this.tokenExpiresAt = 0;

    this.scheduledJobs = [];
    this.isSchedulerRunning = false;

    const delayMinutes =
      Number(process.env.PAY_LATER_DELAY_MINUTES) || PAY_LATER_DEFAULT_MINUTES;
    this.payLaterDelay = delayMinutes * 60 * 1000;

    this.logsDir = path.join(__dirname, '../logs');
    this.ensureLogsDirectory();
  }

  async ensureLogsDirectory() {
    try {
      await fs.mkdir(this.logsDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create logs directory:', error.message);
    }
  }

  logToFile(message) {
    const logFile = path.join(this.logsDir, 'shopify-service.log');
    const timestamp = new Date().toISOString();
    fs.appendFile(logFile, `[${timestamp}] ${message}\n`).catch(() => {});
  }

  // Fetch a fresh access token using the client_credentials grant.
  async fetchNewToken() {
    const url = `https://${this.shop}.myshopify.com/admin/oauth/access_token`;

    // Use native fetch (built into Node 18+) instead of axios for the token request.
    // Render's outbound proxy injects an intermediate certificate that axios rejects
    // with "certificate has expired". Node's native fetch uses the system TLS stack
    // which trusts the proxy CA correctly.
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token request failed: ${response.status} ${text}`);
    }

    const { access_token, expires_in } = await response.json();
    this.token = access_token;
    // expires_in is in seconds; refresh 60s before expiry
    this.tokenExpiresAt = Date.now() + expires_in * 1000;

    const msg = `✅ New access token obtained (expires in ${expires_in}s)`;
    console.log(msg);
    this.logToFile(msg);
    return this.token;
  }

  // Returns a valid token, auto-refreshing if within 60s of expiry.
  async getToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.token;
    }
    return this.fetchNewToken();
  }

  initializeClient() {
    if (!this.shop) throw new Error('SHOPIFY_SHOP is not set');
    if (!this.clientId) throw new Error('SHOPIFY_CLIENT_ID is not set');
    if (!this.clientSecret) throw new Error('SHOPIFY_CLIENT_SECRET is not set');
    this.baseURL = `https://${this.shop}.myshopify.com/admin/api/${this.apiVersion}`;
    console.log(`Shopify client initialized for: ${this.shop}`);
    this.logToFile(`Shopify client initialized for: ${this.shop}`);
  }

  // Build a fresh axios instance with the current valid token.
  async buildClient() {
    const token = await this.getToken();
    return axios.create({
      baseURL: this.baseURL,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
        'User-Agent': 'Shopify-Payment-Capturer/1.0',
      },
      timeout: 30000,
    });
  }

  // Startup token validation
  async refreshAccessToken() {
    try {
      await this.fetchNewToken();
      const client = await this.buildClient();
      const response = await client.get('/shop.json');
      const shopName = response.data?.shop?.name || this.shop;
      const msg = `✅ Token validated for shop: ${shopName}`;
      console.log(msg);
      this.logToFile(msg);
      return this.token;
    } catch (error) {
      const msg = `Error obtaining/validating token: ${error.message}`;
      console.error('❌', msg);
      // Log full error chain to expose the real root cause
      if (error.cause) {
        console.error('  Caused by:', error.cause?.message || String(error.cause));
        if (error.cause?.cause) {
          console.error('  Root cause:', error.cause.cause?.message || String(error.cause.cause));
        }
      }
      console.error('  Error code:', error.code);
      console.error('  Error type:', error.constructor?.name);
      if (error.response) {
        console.error('  HTTP status:', error.response.status);
        console.error('  HTTP body:', JSON.stringify(error.response.data));
      }
      this.logToFile(`ERROR: ${msg}`);
      throw error;
    }
  }

  async getOrder(orderId) {
    const client = await this.buildClient();
    const response = await client.get(`/orders/${orderId}.json`);
    return response.data.order;
  }

  async capturePayment(orderId, transactionId) {
    const client = await this.buildClient();
    try {
      // FIX: Removed amount: null — omitting it captures the full authorized amount
      const response = await client.post(
        `/orders/${orderId}/transactions.json`,
        { transaction: { kind: 'capture', parent_id: transactionId } }
      );
      const msg = `✅ Payment captured for order ${orderId}, transaction ${transactionId}`;
      console.log(msg);
      this.logToFile(msg);
      return response.data.transaction;
    } catch (error) {
      const msg = `Error capturing payment for order ${orderId}: ${error.message}`;
      console.error(msg);
      this.logToFile(`ERROR: ${msg}`);
      if (error.response) console.error('Response:', JSON.stringify(error.response.data));
      throw error;
    }
  }

  async getOrderTransactions(orderId) {
    const client = await this.buildClient();
    const response = await client.get(`/orders/${orderId}/transactions.json`);
    return response.data.transactions;
  }

  async getRecentOrders(limit = 5) {
    const client = await this.buildClient();
    try {
      const response = await client.get(
        `/orders.json?limit=${limit}&status=any&order=created_at+desc`
      );
      return response.data.orders || [];
    } catch (error) {
      console.error('Error fetching recent orders:', error.message);
      return [];
    }
  }

  async processOrder(orderData) {
    try {
      console.log(`🎯 Processing order: ${orderData.id}`);
      this.logToFile(`Processing order: ${orderData.id}`);

      const order = await this.getOrder(orderData.id);
      let paymentFlag = null;

      // 1. note_attributes
      const noteAttr = (order.note_attributes || []).find((a) =>
        ['payment_flag', 'purchase_type'].includes((a.name || '').toLowerCase())
      );
      if (noteAttr) {
        paymentFlag = noteAttr.value.toLowerCase();
        console.log(`✅ Payment flag in note_attributes: ${paymentFlag}`);
      }

      // 2. line item properties
      if (!paymentFlag) {
        for (const item of order.line_items || []) {
          const prop = (item.properties || []).find((p) =>
            ['payment_flag', 'purchase_type'].includes((p.name || '').toLowerCase())
          );
          if (prop) { paymentFlag = prop.value.toLowerCase(); break; }
        }
      }

      // 3. tags
      if (!paymentFlag && order.tags) {
        const tags = order.tags.toLowerCase();
        if (tags.includes('buy_now')) paymentFlag = 'buy_now';
        else if (tags.includes('pay_later')) paymentFlag = 'pay_later';
      }

      if (!paymentFlag) {
        console.log(`ℹ️ No payment flag for order ${order.id}`);
        return;
      }

      const transactions = await this.getOrderTransactions(order.id);
      const authTx = transactions.find(
        (t) => t.kind === 'authorization' && t.status === 'success'
      );

      if (!authTx) {
        console.log(`⚠️ No authorized transaction for order ${order.id}`);
        return;
      }

      if (paymentFlag === 'buy_now') {
        console.log(`💰 buy_now — capturing immediately for order ${order.id}`);
        this.logToFile(`buy_now capture for order ${order.id}`);
        await this.capturePayment(order.id, authTx.id);
      } else if (paymentFlag === 'pay_later') {
        console.log(`⏰ pay_later — scheduling capture for order ${order.id}`);
        this.logToFile(`Scheduling pay_later capture for order ${order.id}`);
        this.schedulePaymentCapture(order.id, authTx.id, this.payLaterDelay);
      }
    } catch (error) {
      const msg = `Error processing order ${orderData.id}: ${error.message}`;
      console.error(msg);
      this.logToFile(`ERROR: ${msg}`);
      throw error;
    }
  }

  schedulePaymentCapture(orderId, transactionId, delay) {
    if (this.scheduledJobs.find((j) => j.orderId === orderId)) {
      console.log(`⚠️ Duplicate job skipped for order ${orderId}`);
      return;
    }

    const scheduledTime = Date.now() + delay;
    const job = { orderId, transactionId, scheduledTime, processing: false, jobId: null };

    job.jobId = setTimeout(async () => {
      if (job.processing) return;
      job.processing = true;
      try {
        console.log(`🔔 Executing scheduled capture for order ${orderId}`);
        this.logToFile(`Executing scheduled capture for order ${orderId}`);
        await this.capturePayment(orderId, transactionId);
        this.removeScheduledJob(orderId);
      } catch (error) {
        job.processing = false;
        console.error(`❌ Scheduled capture failed: ${error.message}`);
        this.logToFile(`Scheduled capture failed: ${error.message}`);
      }
    }, delay);

    this.scheduledJobs.push(job);
    console.log(`📅 Job for order ${orderId} at ${new Date(scheduledTime).toISOString()}`);
  }

  removeScheduledJob(orderId) {
    const idx = this.scheduledJobs.findIndex((j) => j.orderId === orderId);
    if (idx > -1) {
      clearTimeout(this.scheduledJobs[idx].jobId);
      this.scheduledJobs.splice(idx, 1);
      console.log(`🗑️ Removed job for order ${orderId}`);
    }
  }

  getScheduledJobs() {
    return this.scheduledJobs.map((job) => {
      const ms = job.scheduledTime - Date.now();
      return {
        orderId: job.orderId,
        scheduledTime: new Date(job.scheduledTime).toISOString(),
        timeLeft: `${Math.floor(ms/86400000)}d ${Math.floor((ms%86400000)/3600000)}h ${Math.floor((ms%3600000)/60000)}m`,
        timeLeftMs: ms,
      };
    });
  }

  startScheduler() {
    if (this.isSchedulerRunning) return;
    console.log('🚀 Starting payment capture scheduler...');
    this.logToFile('Starting payment capture scheduler');
    this.isSchedulerRunning = true;

    // Safety net: catch any setTimeout that was skipped due to clock skew
    setInterval(() => {
      const now = Date.now();
      this.scheduledJobs.forEach((job) => {
        if (job.scheduledTime <= now && job.jobId && !job.processing) {
          console.log(`⏰ Overdue job detected for order ${job.orderId}`);
          clearTimeout(job.jobId);
          job.jobId = null;
          job.processing = true;
          this.capturePayment(job.orderId, job.transactionId)
            .then(() => this.removeScheduledJob(job.orderId))
            .catch((err) => {
              job.processing = false;
              console.error(`❌ Overdue capture failed: ${err.message}`);
            });
        }
      });
    }, 60000);
  }
}

module.exports = new ShopifyService();
