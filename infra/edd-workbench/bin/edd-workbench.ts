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
    domainName: "stage.xbundle.com",
    // ACM certs for CloudFront must live in us-east-1 regardless of the
    // stack's own region — already issued and validated (not this stack's
    // to create; DNS validation needs control of xbundle.com's actual DNS,
    // which isn't managed in this AWS account's Route53 at all).
    certificateArn: "arn:aws:acm:us-east-1:901407941726:certificate/ee9da748-a427-414a-97f0-9cf54b9f74e8",
  },
});
