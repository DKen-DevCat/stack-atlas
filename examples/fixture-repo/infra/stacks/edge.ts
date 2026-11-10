import { IamRole } from "@cdktf/provider-aws/lib/iam-role";
import { LambdaFunction } from "@cdktf/provider-aws/lib/lambda-function";
import type { CognitoUserPool } from "@cdktf/provider-aws/lib/cognito-user-pool";
import type { AwsProvider } from "@cdktf/provider-aws/lib/provider";
import type { TerraformStack } from "cdktf";

/**
 * /admin/* の viewer-request で JWT を検証する Lambda@Edge。
 * ソースは infra/edge/auth.ts:
 *
 *   export const handler = async (e) => {
 *     const req = e.Records[0].cf.request;
 *     return (await verifyJwt(req)) ? req : redirect("/login");
 *   };
 */
export function createEdge(
  scope: TerraformStack,
  props: { provider: AwsProvider; userPool: CognitoUserPool },
) {
  const role = new IamRole(scope, "authEdgeRole", {
    name: "race-auth-edge",
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: ["lambda.amazonaws.com", "edgelambda.amazonaws.com"] },
          Action: "sts:AssumeRole",
        },
      ],
    }),
  });

  const authEdge = new LambdaFunction(scope, "authEdge", {
    provider: props.provider,
    functionName: "race-auth-edge",
    handler: "auth.handler",
    runtime: "nodejs20.x",
    role: role.arn,
    publish: true, // Lambda@Edge はバージョン付き ARN が必要
    filename: "../infra/edge/auth.zip",
    // Lambda@Edge は環境変数を持てないので、検証先の User Pool はタグで残す
    tags: { UserPoolId: props.userPool.id },
  });

  return { authEdge };
}
