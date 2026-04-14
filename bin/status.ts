#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { StatusStack } from '../lib/status-stack';
import { CertificateStack } from '../lib/certificate-stack';

const app = new cdk.App();

const telegramBotToken = app.node.tryGetContext('telegramBotToken') ?? process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = app.node.tryGetContext('telegramChatId') ?? process.env.TELEGRAM_CHAT_ID;
const telegramWebhookSecret =
  app.node.tryGetContext('telegramWebhookSecret') ?? process.env.TELEGRAM_WEBHOOK_SECRET;
const domainName = app.node.tryGetContext('domainName') ?? 'status.omastore.fi';
const alarmEmail = app.node.tryGetContext('alarmEmail') ?? process.env.ALARM_EMAIL ?? 'tatu.ulmanen@virtue.fi';
const mainRegion = process.env.CDK_DEFAULT_REGION ?? 'eu-north-1';

if (!telegramBotToken || !telegramChatId || !telegramWebhookSecret) {
  throw new Error(
    'Missing required context: telegramBotToken, telegramChatId, telegramWebhookSecret. ' +
      'Pass via `cdk deploy -c key=value` or environment variables TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / TELEGRAM_WEBHOOK_SECRET.'
  );
}

// CloudFront requires the cert in us-east-1, so the cert stack lives there
// and the main stack in eu-north-1 references it cross-region.
const certStack = new CertificateStack(app, 'OmastoreStatusCertStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  crossRegionReferences: true,
  domainName,
});

const statusStack = new StatusStack(app, 'OmastoreStatusStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: mainRegion,
  },
  crossRegionReferences: true,
  domainName,
  certificateArn: certStack.certificateArn,
  telegramBotToken,
  telegramChatId,
  telegramWebhookSecret,
  alarmEmail,
});

statusStack.addDependency(certStack);
