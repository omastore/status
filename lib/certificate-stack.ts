import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
  PhysicalResourceIdReference,
} from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface CertificateStackProps extends cdk.StackProps {
  domainName: string;
}

/**
 * Requests the ACM certificate via a custom resource (does NOT block on
 * validation) so the stack completes quickly and we can surface the DNS
 * validation CNAME record as a CfnOutput. The caller adds the CNAME to
 * PowerDNS manually, ACM validates, and the certificate becomes ISSUED.
 * The main stack, which references this cert ARN, will then be able to
 * attach it to CloudFront.
 */
export class CertificateStack extends cdk.Stack {
  public readonly certificateArn: string;

  constructor(scope: Construct, id: string, props: CertificateStackProps) {
    super(scope, id, props);

    const { domainName } = props;

    const acmPolicy = AwsCustomResourcePolicy.fromStatements([
      new iam.PolicyStatement({
        actions: [
          'acm:RequestCertificate',
          'acm:DescribeCertificate',
          'acm:DeleteCertificate',
          'acm:AddTagsToCertificate',
        ],
        resources: ['*'],
      }),
    ]);

    const request = new AwsCustomResource(this, 'RequestCert', {
      onCreate: {
        service: 'ACM',
        action: 'requestCertificate',
        parameters: {
          DomainName: domainName,
          ValidationMethod: 'DNS',
          IdempotencyToken: cdk.Names.uniqueId(this).slice(0, 32),
        },
        physicalResourceId: PhysicalResourceId.fromResponse('CertificateArn'),
      },
      onDelete: {
        service: 'ACM',
        action: 'deleteCertificate',
        parameters: {
          CertificateArn: new PhysicalResourceIdReference(),
        },
      },
      policy: acmPolicy,
      installLatestAwsSdk: false,
    });

    this.certificateArn = request.getResponseField('CertificateArn');

    const describe = new AwsCustomResource(this, 'DescribeCert', {
      onCreate: {
        service: 'ACM',
        action: 'describeCertificate',
        parameters: { CertificateArn: this.certificateArn },
        physicalResourceId: PhysicalResourceId.of(`describe-${domainName}`),
      },
      onUpdate: {
        service: 'ACM',
        action: 'describeCertificate',
        parameters: { CertificateArn: this.certificateArn },
      },
      policy: acmPolicy,
      installLatestAwsSdk: false,
    });
    describe.node.addDependency(request);

    const validationName = describe.getResponseField(
      'Certificate.DomainValidationOptions.0.ResourceRecord.Name'
    );
    const validationValue = describe.getResponseField(
      'Certificate.DomainValidationOptions.0.ResourceRecord.Value'
    );
    const validationType = describe.getResponseField(
      'Certificate.DomainValidationOptions.0.ResourceRecord.Type'
    );

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: this.certificateArn,
      description: 'ACM certificate ARN — pass to main stack as -c certificateArn=<arn> or via cross-stack ref.',
    });
    new cdk.CfnOutput(this, 'ValidationRecordName', {
      value: validationName,
      description: 'Add this as a CNAME record in PowerDNS.',
    });
    new cdk.CfnOutput(this, 'ValidationRecordValue', {
      value: validationValue,
      description: 'CNAME target for the validation record.',
    });
    new cdk.CfnOutput(this, 'ValidationRecordType', {
      value: validationType,
      description: 'Record type (always CNAME for DNS validation).',
    });
  }

  /**
   * Wrap the raw ARN string in an IClass that downstream stacks can use as
   * an ICertificate. CloudFront just needs the ARN, so `fromCertificateArn`
   * is sufficient.
   */
  public asCertificate(scope: Construct, id: string): acm.ICertificate {
    return acm.Certificate.fromCertificateArn(scope, id, this.certificateArn);
  }
}
