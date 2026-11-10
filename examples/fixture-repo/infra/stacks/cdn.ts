import { CloudfrontCachePolicy } from "@cdktf/provider-aws/lib/cloudfront-cache-policy";
import { CloudfrontDistribution } from "@cdktf/provider-aws/lib/cloudfront-distribution";
import type { LambdaFunction } from "@cdktf/provider-aws/lib/lambda-function";
import type { LambdaFunctionUrl } from "@cdktf/provider-aws/lib/lambda-function-url";
import { S3Bucket } from "@cdktf/provider-aws/lib/s3-bucket";
import { Fn, type TerraformStack } from "cdktf";

// AWS 管理のキャッシュポリシー
const CachingDisabled = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
const CachingOptimized = "658327ea-f89d-4fab-a63d-7f88639e58f6";

export function createCdn(
  scope: TerraformStack,
  props: { nextUrl: LambdaFunctionUrl; authEdge: LambdaFunction },
) {
  // next build の .next/static をデプロイするバケット
  const staticBucket = new S3Bucket(scope, "static", { bucket: "race-web-static" });

  // オリジン（Next の Cache-Control: s-maxage）に従う。Cookie / ヘッダ / クエリはキーに入れない
  const honorOriginHeaders = new CloudfrontCachePolicy(scope, "honorOriginHeaders", {
    name: "race-honor-origin",
    minTtl: 0,
    defaultTtl: 60,
    maxTtl: 300,
    parametersInCacheKeyAndForwardedToOrigin: {
      cookiesConfig: { cookieBehavior: "none" },
      headersConfig: { headerBehavior: "none" },
      queryStringsConfig: { queryStringBehavior: "none" },
      enableAcceptEncodingGzip: true,
    },
  });

  const nextLambdaOrigin = {
    originId: "nextOrigin",
    domainName: Fn.element(Fn.split("/", props.nextUrl.functionUrl), 2),
    customOriginConfig: {
      httpPort: 80,
      httpsPort: 443,
      originProtocolPolicy: "https-only",
      originSslProtocols: ["TLSv1.2"],
    },
  };
  const staticS3Origin = {
    originId: "staticOrigin",
    domainName: staticBucket.bucketRegionalDomainName,
  };

  const cdn = new CloudfrontDistribution(scope, "cdn", {
    enabled: true,
    aliases: ["races.example.com"],
    origin: [nextLambdaOrigin, staticS3Origin],
    defaultCacheBehavior: {
      targetOriginId: "nextOrigin",
      viewerProtocolPolicy: "redirect-to-https",
      allowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
      cachedMethods: ["GET", "HEAD"],
      cachePolicyId: honorOriginHeaders.id, // s-maxage に従う
    },
    orderedCacheBehavior: [
      {
        pathPattern: "/_next/static/*",
        targetOriginId: "staticOrigin",
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD"],
        cachedMethods: ["GET", "HEAD"],
        cachePolicyId: CachingOptimized,
      },
      {
        pathPattern: "/races/*",
        targetOriginId: "nextOrigin",
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD"],
        cachedMethods: ["GET", "HEAD"],
        cachePolicyId: honorOriginHeaders.id,
      },
      {
        pathPattern: "/",
        targetOriginId: "nextOrigin",
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD"],
        cachedMethods: ["GET", "HEAD"],
        cachePolicyId: honorOriginHeaders.id,
      },
      {
        pathPattern: "/admin/*",
        targetOriginId: "nextOrigin",
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
        cachedMethods: ["GET", "HEAD"],
        cachePolicyId: CachingDisabled,
        lambdaFunctionAssociation: [
          {
            eventType: "viewer-request",
            lambdaArn: props.authEdge.qualifiedArn,
          },
        ],
      },
    ],
    restrictions: { geoRestriction: { restrictionType: "none" } },
    viewerCertificate: { cloudfrontDefaultCertificate: true },
  });

  return { cdn, staticBucket };
}
