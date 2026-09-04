import * as cdk from "aws-cdk-lib";
import { EddWorkbenchStack } from "../lib/edd-workbench-stack.js";

const app = new cdk.App();

// This is reviewable infrastructure-as-code only — nobody has run `cdk
// deploy` against a real AWS account yet. See the build plan §1/§9: region
// is eu-west-2 (London) for UK data-residency reasons specific to this
// product's client base.
new EddWorkbenchStack(app, "EddWorkbenchStaging", {
  environmentName: "staging",
  env: { region: "eu-west-2" },
  customDomain: {
    domainName: "collate.xbundle.co.uk",
    // ACM certs for CloudFront must live in us-east-1 regardless of the
    // stack's own region — imported (not ACM-issued) from a real cert
    // (RapidSSL/DigiCert, valid through 2027-03-21) provided out of band,
    // since this account doesn't manage xbundle.co.uk's actual DNS to do
    // ACM's own DNS validation.
    certificateArn: "arn:aws:acm:us-east-1:901407941726:certificate/4f0a2f4d-4760-44e1-a2f4-073acfa022af",
  },
});
