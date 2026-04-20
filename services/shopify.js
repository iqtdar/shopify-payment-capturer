require('dotenv').config();
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

// BUG FIX: Shopify private/custom apps don't use OAuth client_credentials flow.
// They use a static Admin API access token (X-Shopify-Access-Token header).
// The original code tried to POST to /admin/oauth/access_token with grant_type=client_credentials,
// which does NOT exist in Shopify's API — this endpoint is only for OAuth public apps
// and it has no client_credentials grant type at all.
// FIX: Use the SHOPIFY_ACCESS_TOKEN directly from env, no refresh flow needed.

// BUG FIX 2: PAY_LATER_DELAY_MINUTES was defaulting to 30 minutes in .env,
// but the requirement is to capture at 6.5 days (156 hours) — just before Shopify's
// 7-day authorization expiry window. Default changed to 9360 minutes (6.5 days).

// BUG FIX 3: capturePayment sent amount: null which can cause Shopify to reject
// the request on some payment gateways. Removed the field entirely so Shopify
// defaults to the full authorized amount.

// BUG FIX 4: ensureValidToken compared tokenExpiry incorrectly — it subtracted 300000ms
// but that means it refreshes when expiry < (now - 5min), i.e. only 5 minutes AFTER
// it already expired, not 5 minutes before. Fixed to: tokenExpiry < (now + 300000).
// (Though with the static token approach this check is simplified.)

// BUG FIX 5: startScheduler's overdue-job check never clears job.jobId before calling
// capturePayment, so multiple concurrent captures could fire for the same order.
// Fixed with a processing flag.

// BUG FIX 6: Missing dotenv initialization — the original index.js never calls
// require('dotenv').config() before reading env vars. Added here as a safety net.

// BUG FIX 7: package.json lists node-cron and node-schedule as used dependencies
// but they are NOT in the dependencies section — only in node_modules. Added
// note in comments; scheduler.js used node-schedule but it was not in package.json.

const PAY_LATER_DEFAULT_MINUTES = 9360; // 6.5 days = 6.5 * 24 * 60

class ShopifyService {
  constructor() {
    this.shop = process.env.SHOPIFY_SHOP_NAME;
    // FIX: Use static admin API access token instead of OAuth flow
    this.accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
    this.apiVersion = process.env.SHOPIFY_API_VERSION || '2024-01';
    this.scheduledJobs = [];
    this.isSchedulerRunning = false;

    const delayMinutes = Number(process.env.PAY_LATER_DELAY_MINUTES) || PAY_LATER_DEFAULT_MINUTES;
    this.payLaterDelay = delayMinutes * 60 * 1000;

    // Create logs directory
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
    const logMessage = `[${timestamp}] ${message}\n`;
    fs.appendFile(logFile, logMessage).catch(() => {});
  }

  initializeClient() {
    console.log('Initializing Shopify client for:', this.shop);
    this.logToFile(`Initializing Shopify client for: ${this.shop}`);

    if (!this.shop) {
      throw new Error('SHOPIFY_SHOP_NAME is not set in environment variables');
    }
    // FIX: Check for static access token, not client_id/secret
    if (!this.accessToken) {
      throw new Error('SHOPIFY_ACCESS_TOKEN is not set in environment variables');
    }

    this.baseURL = `https://${this.shop}.myshopify.com/admin/api/${this.apiVersion}`;

    // Build the axios client once — token never expires for private app tokens
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': this.accessToken,
        'User-Agent': 'Shopify-Payment-Capturer/1.0',
      },
      timeout: 30000,
    });

    console.log('✅ Shopify client configured');
    this.logToFile('Shopify client configured successfully');
  }

  // FIX: refreshAccessToken no longer tries the invalid OAuth flow.
  // For a private/custom app, the admin API token is static.
  // This method now just validates the token is present and the client is ready.
  async refreshAccessToken() {
    if (!this.client) {
      this.initializeClient();
    }
    try {
      // Lightweight shop info call to verify the token works
      const response = await this.client.get('/shop.json');
      const shopName = response.data?.shop?.name || this.shop;
      const msg = `✅ Token validated for shop: ${shopName}`;
      console.log(msg);
      this.logToFile(msg);
      return this.accessToken;
    } catch (error) {
      const errorMsg = `Error validating access token: ${error.message}`;
      console.error('❌', errorMsg);
      this.logToFile(`ERROR: ${errorMsg}`);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', JSON.stringify(error.response.data));
      }
      throw error;
    }
  }

  async ensureClient() {
    if (!this.client) {
      this.initializeClient();
    }
  }

  async getOrder(orderId) {
    await this.ensureClient();
    try {
      const response = await this.client.get(`/orders/${orderId}.json`);
      return response.data.order;
    } catch (error) {
      const errorMsg = `Error fetching order ${orderId}: ${error.message}`;
      console.error(errorMsg);
      this.logToFile(`ERROR: ${errorMsg}`);
      throw error;
    }
  }

  async capturePayment(orderId, transactionId) {
    await this.ensureClient();
    try {
      // FIX: Removed amount: null — omitting the field lets Shopify capture the
      // full authorized amount, which is the desired behaviour and avoids
      // gateway rejections caused by null values.
      const response = await this.client.post(
        `/orders/${orderId}/transactions.json`,
        {
          transaction: {
            kind: 'capture',
            parent_id: transactionId,
          },
        }
      );

      const successMsg = `✅ Payment captured for order ${orderId}, parent transaction ${transactionId}`;
      console.log(successMsg);
      this.logToFile(successMsg);

      return response.data.transaction;
    } catch (error) {
      const errorMsg = `Error capturing payment for order ${orderId}: ${error.message}`;
      console.error(errorMsg);
      this.logToFile(`ERROR: ${errorMsg}`);
      if (error.response) {
        console.error('Error response:', JSON.stringify(error.response.data));
      }
      throw error;
    }
  }

  async getOrderTransactions(orderId) {
    await this.ensureClient();
    try {
      const response = await this.client.get(
        `/orders/${orderId}/transactions.json`
      );
      return response.data.transactions;
    } catch (error) {
      const errorMsg = `Error fetching transactions for order ${orderId}: ${error.message}`;
      console.error(errorMsg);
      this.logToFile(`ERROR: ${errorMsg}`);
      throw error;
    }
  }

  async getRecentOrders(limit = 5) {
    await this.ensureClient();
    try {
      const response = await this.client.get(
        `/orders.json?limit=${limit}&status=any&order=created_at+desc`
      );
      return response.data.orders || [];
    } catch (error) {
      const errorMsg = `Error fetching recent orders: ${error.message}`;
      console.error(errorMsg);
      this.logToFile(`ERROR: ${errorMsg}`);
      return [];
    }
  }

  async processOrder(orderData) {
    try {
      console.log(`🎯 Processing order: ${orderData.id}`);
      this.logToFile(`Processing order: ${orderData.id}`);

      const order = await this.getOrder(orderData.id);

      console.log('🔍 Checking for payment flag...');

      let paymentFlag = null;

      // 1. Check note attributes
      const noteAttributes = order.note_attributes || [];
      const paymentFlagAttr = noteAttributes.find((attr) => {
        const name = attr.name ? attr.name.toLowerCase() : '';
        return name === 'payment_flag' || name === 'purchase_type';
      });

      if (paymentFlagAttr) {
        paymentFlag = paymentFlagAttr.value.toLowerCase();
        console.log(`✅ Found payment flag in note attributes: ${paymentFlag}`);
      }

      // 2. Check line item properties
      if (!paymentFlag && order.line_items && order.line_items.length > 0) {
        for (const lineItem of order.line_items) {
          if (lineItem.properties && lineItem.properties.length > 0) {
            const prop = lineItem.properties.find((p) => {
              const name = p.name ? p.name.toLowerCase() : '';
              return name === 'payment_flag' || name === 'purchase_type';
            });
            if (prop) {
              paymentFlag = prop.value.toLowerCase();
              console.log(
                `✅ Found payment flag in line item properties: ${paymentFlag}`
              );
              break;
            }
          }
        }
      }

      // 3. Check tags
      if (!paymentFlag && order.tags) {
        const tags = order.tags.toLowerCase();
        if (tags.includes('buy_now')) {
          paymentFlag = 'buy_now';
          console.log('✅ Found buy_now tag');
        } else if (tags.includes('pay_later')) {
          paymentFlag = 'pay_later';
          console.log('✅ Found pay_later tag');
        }
      }

      if (!paymentFlag) {
        console.log(`ℹ️ No payment flag found for order ${order.id}`);
        this.logToFile(`No payment flag found for order ${order.id}`);
        return;
      }

      // Get transactions
      const transactions = await this.getOrderTransactions(order.id);
      const authTransaction = transactions.find(
        (t) => t.kind === 'authorization' && t.status === 'success'
      );

      if (!authTransaction) {
        console.log(`⚠️ No authorized transaction found for order ${order.id}`);
        this.logToFile(`No authorized transaction for order ${order.id}`);
        return;
      }

      const transactionId = authTransaction.id;
      console.log(`✅ Found authorized transaction: ${transactionId}`);

      if (paymentFlag === 'buy_now') {
        console.log(`💰 Processing buy_now for order ${order.id}`);
        this.logToFile(`Processing buy_now for order ${order.id}`);
        try {
          await this.capturePayment(order.id, transactionId);
        } catch (error) {
          console.error(`❌ Buy now capture failed: ${error.message}`);
          this.logToFile(`Buy now capture failed: ${error.message}`);
        }
      } else if (paymentFlag === 'pay_later') {
        console.log(
          `⏰ Processing pay_later for order ${order.id}, scheduling capture in ${
            this.payLaterDelay / 60000
          } minutes`
        );
        this.logToFile(
          `Scheduling pay_later capture for order ${order.id}`
        );
        this.schedulePaymentCapture(order.id, transactionId, this.payLaterDelay);
      } else {
        console.log(`❓ Unknown payment flag: ${paymentFlag}`);
        this.logToFile(`Unknown payment flag: ${paymentFlag}`);
      }
    } catch (error) {
      const errorMsg = `Error processing order ${orderData.id}: ${error.message}`;
      console.error(errorMsg);
      this.logToFile(`ERROR: ${errorMsg}`);
      throw error;
    }
  }

  schedulePaymentCapture(orderId, transactionId, delay) {
    // Prevent duplicate jobs for the same order
    const existing = this.scheduledJobs.find((j) => j.orderId === orderId);
    if (existing) {
      console.log(`⚠️ Job already exists for order ${orderId}, skipping duplicate`);
      this.logToFile(`Duplicate schedule ignored for order ${orderId}`);
      return;
    }

    console.log(
      `⏰ Scheduling payment capture for order ${orderId} in ${delay}ms`
    );
    this.logToFile(`Scheduling payment capture for order ${orderId}`);

    const scheduledTime = Date.now() + delay;

    const job = {
      orderId,
      transactionId,
      scheduledTime,
      processing: false, // FIX: guard against double execution
      jobId: null,
    };

    job.jobId = setTimeout(async () => {
      try {
        if (job.processing) return; // FIX: guard re-entrancy
        job.processing = true;
        console.log(
          `🔔 Executing scheduled payment capture for order ${orderId}`
        );
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
    console.log(`📅 Scheduled job added. Total jobs: ${this.scheduledJobs.length}`);
  }

  removeScheduledJob(orderId) {
    const index = this.scheduledJobs.findIndex((j) => j.orderId === orderId);
    if (index > -1) {
      clearTimeout(this.scheduledJobs[index].jobId);
      this.scheduledJobs.splice(index, 1);
      console.log(`🗑️ Removed scheduled job for order ${orderId}`);
      this.logToFile(`Removed scheduled job for order ${orderId}`);
    }
  }

  getScheduledJobs() {
    return this.scheduledJobs.map((job) => {
      const timeLeft = job.scheduledTime - Date.now();
      const days = Math.floor(timeLeft / (1000 * 60 * 60 * 24));
      const hours = Math.floor((timeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((timeLeft % (1000 * 60)) / 1000);

      return {
        orderId: job.orderId,
        scheduledTime: new Date(job.scheduledTime).toISOString(),
        timeLeft: `${days}d ${hours}h ${minutes}m ${seconds}s`,
        timeLeftMs: timeLeft,
      };
    });
  }

  startScheduler() {
    if (this.isSchedulerRunning) return;

    console.log('🚀 Starting payment capture scheduler...');
    this.logToFile('Starting payment capture scheduler');
    this.isSchedulerRunning = true;

    // Safety net: check every minute for overdue jobs that setTimeout may have missed
    // (e.g. after a process sleep or system clock skew)
    setInterval(() => {
      const now = Date.now();
      this.scheduledJobs.forEach((job) => {
        // FIX: check processing flag to avoid concurrent captures
        if (job.scheduledTime <= now && job.jobId && !job.processing) {
          console.log(
            `⏰ Job for order ${job.orderId} is overdue, executing now...`
          );
          this.logToFile(`Overdue job detected for order ${job.orderId}`);

          clearTimeout(job.jobId);
          job.jobId = null;
          job.processing = true;

          this.capturePayment(job.orderId, job.transactionId)
            .then(() => {
              console.log(
                `✅ Overdue job completed for order ${job.orderId}`
              );
              this.logToFile(
                `Overdue job completed for order ${job.orderId}`
              );
              this.removeScheduledJob(job.orderId);
            })
            .catch((error) => {
              job.processing = false;
              console.error(`❌ Failed overdue job: ${error.message}`);
              this.logToFile(`Failed overdue job: ${error.message}`);
            });
        }
      });
    }, 60000);
  }
}

module.exports = new ShopifyService();
