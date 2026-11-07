import { IamRole } from "@cdktf/provider-aws/lib/iam-role";
import { LambdaFunction } from "@cdktf/provider-aws/lib/lambda-function";
import { LambdaFunctionUrl } from "@cdktf/provider-aws/lib/lambda-function-url";
import type { TerraformStack } from "cdktf";

export function createWeb(scope: TerraformStack, props: { apiEndpoint: string }) {
  const role = new IamRole(scope, "nextRole", {
    name: "race-web",
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "lambda.amazonaws.com" },
          Action: "sts:AssumeRole",
        },
      ],
    }),
  });

  // Next.js standalone を Lambda Web Adapter で動かす
  const next = new LambdaFunction(scope, "next", {
    functionName: "race-web",
    handler: "run.sh", // Lambda Web Adapter
    runtime: "nodejs20.x",
    memorySize: 1024,
    timeout: 30,
    role: role.arn,
    filename: "../apps/web/.next/standalone.zip",
    layers: ["arn:aws:lambda:ap-northeast-1:753240598075:layer:LambdaAdapterLayerX86:24"],
    environment: {
      variables: {
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/bootstrap",
        PORT: "3000",
        API_BASE_URL: props.apiEndpoint,
      },
    },
  });

  const nextUrl = new LambdaFunctionUrl(scope, "nextUrl", {
    functionName: next.functionName,
    authorizationType: "NONE",
  });

  return { next, nextUrl };
}
