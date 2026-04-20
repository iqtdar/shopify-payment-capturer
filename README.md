# Shopify Payment Capturer — Render Deployment Guide
## Professional Plan

---

## Overview

Render hosts your Node.js app as a **Web Service**. On the Professional plan the service runs 24/7 (no sleeping), which is essential for this app because it holds scheduled payment capture jobs in memory.

Your app will get a free `*.onrender.com` URL out of the box, and you can attach a custom domain.

---

## Step 1 — Push your code to GitHub

Render deploys directly from a Git repository.

1. Create a new GitHub repo (e.g. `shopify-payment-capturer`)
2. Extract the fixed app zip and push it:

```bash
unzip shopify-payment-capturer-fixed.zip
cd shopify-payment-capturer

git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/shopify-payment-capturer.git
git push -u origin main
```

3. Copy `render.yaml` (from this package) into the repo root and commit it:

```bash
cp /path/to/render.yaml .
git add render.yaml
git commit -m "Add Render blueprint"
git push
```

---

## Step 2 — Create the Web Service on Render

### Option A — Using the Blueprint (recommended)

1. Go to [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint**
2. Connect your GitHub account if not already connected
3. Select the `shopify-payment-capturer` repo
4. Render finds `render.yaml` automatically and shows a preview
5. Click **Apply** — Render creates the service

### Option B — Manual setup

1. **New** → **Web Service**
2. Connect your GitHub repo
3. Fill in:
   - **Name:** `shopify-payment-capturer`
   - **Runtime:** Node
   - **Build Command:** `npm install --omit=dev`
   - **Start Command:** `node index.js`
   - **Plan:** Starter (Professional plan)
4. Set environment variables (next step)
5. Click **Create Web Service**

---

## Step 3 — Set Secret Environment Variables

> ⚠️ Never put real credentials in `render.yaml` — it's committed to Git.
> Set secrets in the Render Dashboard only.

Go to your service → **Environment** tab → **Add Environment Variable**:

| Key | Value | Notes |
|-----|-------|-------|
| `SHOPIFY_SHOP_NAME` | `your-shop-name` | Just the name, no `.myshopify.com` |
| `SHOPIFY_ACCESS_TOKEN` | `shpat_xxxx...` | From Shopify Admin → Settings → Apps → Develop apps |
| `SHOPIFY_WEBHOOK_SECRET` | `your-secret` | From Shopify Admin → Settings → Notifications → Webhooks |
| `NODE_ENV` | `production` | Already in render.yaml |
| `PAY_LATER_DELAY_MINUTES` | `9360` | Already in render.yaml (6.5 days) |

After adding all variables, click **Save Changes** — this triggers a redeploy automatically.

---

## Step 4 — Get Your Render URL

Once deployed, your service URL appears at the top of the dashboard:
```
https://shopify-payment-capturer.onrender.com
```

Test it:
```bash
curl https://shopify-payment-capturer.onrender.com/health
```

Expected response:
```json
{
  "status": "healthy",
  "shop": "your-shop-name",
  "uptime": 42,
  ...
}
```

---

## Step 5 — Register Webhooks in Shopify

1. Go to **Shopify Admin → Settings → Notifications → Webhooks**
2. Add these two webhooks:

| Event | URL |
|-------|-----|
| Order creation | `https://shopify-payment-capturer.onrender.com/webhooks/orders/create` |
| Order update | `https://shopify-payment-capturer.onrender.com/webhooks/orders/updated` |

3. Copy the **webhook signing secret** Shopify shows you and paste it into Render as `SHOPIFY_WEBHOOK_SECRET`

---

## Step 6 — Custom Domain (Optional)

1. Render dashboard → your service → **Settings** → **Custom Domains**
2. Add your domain (e.g. `capture.yourdomain.com`)
3. Render gives you a CNAME record to add in your DNS provider
4. SSL certificate is issued automatically (Let's Encrypt)
5. Update your Shopify webhook URLs to use the custom domain

---

## Useful Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Service health + uptime |
| `GET /status` | HTML status dashboard |
| `GET /scheduled-jobs` | View pending payment captures |
| `GET /test/shop` | Verify Shopify token works |
| `GET /test/orders` | View last 5 orders |
| `GET /debug/order/:id` | Inspect a specific order |
| `POST /debug/capture/:id` | Manually trigger a capture |

---

## Monitoring & Logs

- **Live logs:** Render Dashboard → your service → **Logs** tab
- **Metrics:** Dashboard → **Metrics** (CPU, memory, response times)
- **Alerts:** Dashboard → **Notifications** — set up email/Slack alerts for service restarts

---

## Auto-Deploy on Git Push

With `autoDeploy: true` in `render.yaml`, every push to `main` triggers a new deploy automatically. Zero-downtime deploys are included on the Professional plan.

To deploy manually: Dashboard → **Manual Deploy** → **Deploy latest commit**

---

## Important: Scheduler Persistence

This app schedules payment captures in memory using `setTimeout`. This means:

- ✅ Jobs persist as long as the service is running
- ⚠️ **Jobs are lost if the service restarts** (deploy, crash, etc.)

On the Professional plan, deploys use a zero-downtime swap — the old instance stays alive until the new one is healthy, so brief in-flight jobs have a window to complete. However, for rock-solid reliability on long 6.5-day timers, consider upgrading to a persistent store:

**Recommendation:** Add a Redis-backed job queue (e.g. `bull` or `bullmq`) using Render's [Redis service](https://render.com/docs/redis). This way jobs survive restarts. Ask if you'd like that added.

---

## Cost (Professional Plan)

| Resource | Monthly Cost |
|----------|-------------|
| Starter Web Service | $7/mo |
| Custom domain SSL | Free |
| Bandwidth (first 100GB) | Free |
| **Total** | **$7/mo** |

Upgrade to **Standard** ($25/mo, 2GB RAM) only if you're scheduling hundreds of concurrent jobs.
