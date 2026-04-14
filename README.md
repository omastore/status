# Omastore Status

Self-hosted status page for Omastore services, running entirely on AWS.

- **Checker Lambda** probes three endpoints every minute via EventBridge and writes state to S3.
- **Webhook Lambda** (API Gateway) receives Telegram updates so the on-call team can post incident updates, open manual incidents, and close them — all from the Telegram group.
- **Static site** on S3 + CloudFront at `https://status.omastore.fi` reads `state.json` directly and re-renders every 10 seconds. UI is in Finnish; ops alerts stay in English.
- **Self-watchdog**: CloudWatch alarms → SNS → email if the checker stops running or starts erroring.

```
                EventBridge (1 min)
                       │
                       ▼
  ┌──────────────┐        ┌───────────────┐
  │ Checker λ    │──────▶ │ S3: state.json│ ◀─── CloudFront ◀── browsers
  └──────────────┘        └───────────────┘          ▲
        │                         ▲                  │
        │ Telegram alerts         │                  │ S3: index.html, app.js, …
        ▼                         │
   Telegram group ─reply──▶ API GW ─▶ Webhook λ ─────┘
```

## Prerequisites

- AWS account with CDK bootstrapped **in both regions**:
  ```bash
  cdk bootstrap aws://<account>/eu-north-1
  cdk bootstrap aws://<account>/us-east-1   # required — the ACM cert lives here
  ```
- DNS managed in **PowerDNS** (no Route 53). You'll add two CNAME records manually — see below.
- Node.js 20+.
- Telegram bot (from @BotFather) and the chat ID of the alerts group.

## Configuration

Three secrets must be passed at deploy time — either as CDK context or as environment variables:

| Context key / env var                                    | Purpose                                                |
| -------------------------------------------------------- | ------------------------------------------------------ |
| `telegramBotToken` / `TELEGRAM_BOT_TOKEN`                | Bot token from @BotFather                              |
| `telegramChatId` / `TELEGRAM_CHAT_ID`                    | Group chat ID (negative number for groups)             |
| `telegramWebhookSecret` / `TELEGRAM_WEBHOOK_SECRET`      | Random string; Telegram echoes it as a header so the Lambda can verify updates |

Optional context:

- `domainName` — default `status.omastore.fi` (set in `cdk.json`)
- `alarmEmail` / `ALARM_EMAIL` — inbox for checker-failure alarms (default `tatu.ulmanen@virtue.fi`, set in `bin/status.ts`). AWS will send a one-time SNS subscription confirmation link — click it once after first deploy.

Local deploy convention: secrets live in `.env` (gitignored). The `deploy` scripts source it automatically.

## Deploy

The stack is split in two so you can grab the ACM DNS-validation record before CloudFront tries to attach the certificate.

### Step 1 — Request the certificate

```bash
bun install
bun -b run deploy:cert
```

This completes in ~30 seconds and prints:

- `CertificateArn` — the ACM cert ARN
- `ValidationRecordName` — name of the CNAME to add in PowerDNS
- `ValidationRecordValue` — value of the CNAME to add in PowerDNS
- `ValidationRecordType` — always `CNAME`

### Step 2 — Add CNAMEs to PowerDNS

Add **two** CNAME records in PowerDNS:

1. **Cert validation** (temporary — ACM uses it once to issue the cert, then you can keep it to let ACM auto-renew):
   ```
   <ValidationRecordName>   CNAME   <ValidationRecordValue>
   ```
2. **Status site** — added after Step 3 finishes:
   ```
   status.omastore.fi   CNAME   <CloudFrontDomain>
   ```

Wait until `aws acm describe-certificate --certificate-arn $CERT_ARN --region us-east-1 --query 'Certificate.Status'` returns `"ISSUED"` (usually 1–5 minutes after the CNAME propagates).

### Step 3 — Deploy the main stack

```bash
bun -b run deploy:site
```

Prints:

- `SiteUrl` — `https://status.omastore.fi`
- `CloudFrontDomain` — `dxxxx.cloudfront.net` — target of the site CNAME you add in PowerDNS
- `WebhookUrl` — API Gateway URL for the Telegram webhook
- `DistributionId`, `StateBucket`

After the CloudFront CNAME propagates, the site is live.

> **Tip**: you can also run `bun -b run deploy` (alias for `cdk deploy --all`) up front; the main stack will sit waiting for CloudFront until the certificate hits ISSUED, and you can do Step 2 during that wait.

After the first `deploy:site` completes, AWS emails `alarmEmail` a one-time "Confirm subscription" link. Click it or alarms won't reach your inbox.

## Register the Telegram webhook

After the first successful deploy, take the `WebhookUrl` output and register it:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=$WEBHOOK_URL/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
  -d 'allowed_updates=["message","channel_post"]'
```

Verify:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

## Usage (Telegram commands)

All commands are posted in the alerts group.

| Action                                                                       | Command                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| Automatic incident — checker detects downtime and posts the alert itself.    | _no action required_                                   |
| Add an update to an incident                                                 | **Reply** to the incident alert with any plain text    |
| Close an incident manually                                                   | **Reply** to the incident alert with `/close`          |
| Open a manual incident                                                       | `/incident Database slow after deploy`                 |
| Announce planned maintenance                                                 | `/maintenance Database failover at 22:00 UTC`          |

The bot replies ✅ to confirm that each command was processed.

## What is monitored

Defined in [lambdas/shared/types.ts](lambdas/shared/types.ts):

- `Omastore Website` — `https://www.omastore.fi` (HTTP 200 expected)
- `Omastore Admin` — `https://api.omastore.fi/health/nginx` (HTTP 200; `{"status":"degraded"}` body → degraded)
- `Omastore API` — `https://api.omastore.fi/health/frankenphp` (HTTP 200; `{"status":"degraded"}` body → degraded)

Endpoints have a 10-second timeout. Anything non-200, network failure, or timeout → **down**.

## Updating

Full redeploy (site + lambdas + infra):

```bash
bun -b run deploy:site
```

**UI-only** changes (HTML/CSS/JS in `site/`) — skip CloudFormation entirely, just sync to S3. CloudFront has zero TTL so changes appear immediately:

```bash
bun -b run sync:ui
```

For Lambda-only changes, `bunx cdk deploy --hotswap OmastoreStatusStack` is much faster than a full redeploy.

## Self-monitoring

Two CloudWatch alarms wired into the stack, both email `alarmEmail` via SNS:

- `omastore-status-checker-not-running` — Invocations < 1 for 10 minutes (EventBridge misfire, Lambda disabled, regional outage)
- `omastore-status-checker-errors` — ≥ 3 errors in 10 minutes

Test the alarm path without taking the checker down:

```bash
aws cloudwatch set-alarm-state --region eu-north-1 \
  --alarm-name omastore-status-checker-not-running \
  --state-value ALARM --state-reason 'test'
```

CloudWatch auto-returns it to OK on the next metric tick.

## Teardown

```bash
bunx cdk destroy --all
```

The S3 bucket is retained on stack deletion (it holds `state.json`). Empty and delete it manually if you want a full wipe.

## Concurrency

Both Lambdas update `state.json` via S3 **conditional writes** (`If-Match: <etag>`). On a 412 Precondition Failed, the helper re-reads and retries up to 5 times with jittered backoff — so the checker and webhook can write concurrently without races. See [lambdas/shared/state.ts](lambdas/shared/state.ts).
