import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2int from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as path from 'path';

export interface StatusStackProps extends cdk.StackProps {
  domainName: string;
  certificateArn: string;
  telegramBotToken: string;
  telegramChatId: string;
  telegramWebhookSecret: string;
  alarmEmail: string;
}

export class StatusStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StatusStackProps) {
    super(scope, id, props);

    const { domainName, certificateArn, telegramBotToken, telegramChatId, telegramWebhookSecret, alarmEmail } = props;

    // ── S3 bucket for static site + state.json ────────────────────────────
    const bucket = new s3.Bucket(this, 'StatusBucket', {
      bucketName: `omastore-status-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      enforceSSL: true,
    });

    // ── Certificate (imported from CertificateStack) ──────────────────────
    const certificate = acm.Certificate.fromCertificateArn(this, 'SiteCertificate', certificateArn);

    // ── CloudFront distribution (no caching — pass-through to S3) ─────────
    const oac = new cloudfront.S3OriginAccessControl(this, 'OAC');

    // CloudFront disallows enableAcceptEncoding* flags when TTLs are all 0,
    // so this policy is pure pass-through with no compression normalization.
    const noCachePolicy = new cloudfront.CachePolicy(this, 'NoCachePolicy', {
      cachePolicyName: `omastore-status-no-cache-${this.account}`,
      defaultTtl: cdk.Duration.seconds(0),
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(0),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      certificate,
      domainNames: [domainName],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket, { originAccessControl: oac }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: noCachePolicy,
        compress: true,
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    // ── Lambda: checker ───────────────────────────────────────────────────
    const commonEnv = {
      TELEGRAM_BOT_TOKEN: telegramBotToken,
      TELEGRAM_CHAT_ID: telegramChatId,
      STATE_BUCKET: bucket.bucketName,
    };

    const checkerFn = new lambdaNode.NodejsFunction(this, 'CheckerFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '..', 'lambdas', 'checker', 'index.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(45),
      environment: commonEnv,
      bundling: { minify: true, sourceMap: false, target: 'node20' },
    });

    bucket.grantReadWrite(checkerFn, 'state.json');

    new events.Rule(this, 'CheckerSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(checkerFn)],
    });

    // ── Lambda: webhook ───────────────────────────────────────────────────
    const webhookFn = new lambdaNode.NodejsFunction(this, 'WebhookFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '..', 'lambdas', 'webhook', 'index.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(20),
      environment: {
        ...commonEnv,
        TELEGRAM_WEBHOOK_SECRET: telegramWebhookSecret,
      },
      bundling: { minify: true, sourceMap: false, target: 'node20' },
    });

    bucket.grantReadWrite(webhookFn, 'state.json');

    const httpApi = new apigwv2.HttpApi(this, 'WebhookApi', {
      apiName: 'omastore-status-webhook',
    });
    httpApi.addRoutes({
      path: '/telegram/webhook',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2int.HttpLambdaIntegration('WebhookIntegration', webhookFn),
    });

    // ── Deploy static site ────────────────────────────────────────────────
    new s3deploy.BucketDeployment(this, 'SiteDeploy', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'site'))],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
      exclude: ['state.json'],
      prune: false,
      cacheControl: [s3deploy.CacheControl.fromString('no-store, max-age=0')],
    });

    // ── Self-monitoring alarms ────────────────────────────────────────────
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: 'Omastore Status — Checker Alarms',
    });
    alarmTopic.addSubscription(new snsSubs.EmailSubscription(alarmEmail));
    const alarmAction = new cwActions.SnsAction(alarmTopic);

    // Alarm if the checker hasn't run in ~10 minutes (should run every minute).
    new cloudwatch.Alarm(this, 'CheckerNotRunningAlarm', {
      alarmName: 'omastore-status-checker-not-running',
      alarmDescription: 'Checker Lambda has not been invoked for 10 minutes — the status page will go stale.',
      metric: checkerFn.metricInvocations({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }).addAlarmAction(alarmAction);

    // Alarm if the checker is erroring consistently.
    new cloudwatch.Alarm(this, 'CheckerErrorsAlarm', {
      alarmName: 'omastore-status-checker-errors',
      alarmDescription: 'Checker Lambda has errored on multiple consecutive runs.',
      metric: checkerFn.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 3,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    // ── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'SiteUrl', { value: `https://${domainName}` });
    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: distribution.distributionDomainName,
      description: `Create a CNAME in PowerDNS: ${domainName} → <this value>`,
    });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'WebhookUrl', { value: `${httpApi.apiEndpoint}/telegram/webhook` });
    new cdk.CfnOutput(this, 'StateBucket', { value: bucket.bucketName });
  }
}
