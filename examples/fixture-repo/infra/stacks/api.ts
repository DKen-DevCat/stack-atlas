import { Apigatewayv2Api } from "@cdktf/provider-aws/lib/apigatewayv2-api";
import { Apigatewayv2Integration } from "@cdktf/provider-aws/lib/apigatewayv2-integration";
import { Apigatewayv2Route } from "@cdktf/provider-aws/lib/apigatewayv2-route";
import { Apigatewayv2Stage } from "@cdktf/provider-aws/lib/apigatewayv2-stage";
import { DataAwsIamPolicyDocument } from "@cdktf/provider-aws/lib/data-aws-iam-policy-document";
import type { DynamodbTable } from "@cdktf/provider-aws/lib/dynamodb-table";
import { IamRole } from "@cdktf/provider-aws/lib/iam-role";
import { IamRolePolicy } from "@cdktf/provider-aws/lib/iam-role-policy";
import { LambdaFunction } from "@cdktf/provider-aws/lib/lambda-function";
import { LambdaPermission } from "@cdktf/provider-aws/lib/lambda-permission";
import type { TerraformStack } from "cdktf";

export function createApi(scope: TerraformStack, props: { table: DynamodbTable }) {
  const role = new IamRole(scope, "apiRole", {
    name: "race-api",
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

  const tableAccess = new DataAwsIamPolicyDocument(scope, "apiTableAccess", {
    statement: [
      {
        actions: ["dynamodb:Query", "dynamodb:PutItem", "dynamodb:GetItem"],
        resources: [props.table.arn],
      },
    ],
  });
  new IamRolePolicy(scope, "apiRolePolicy", {
    role: role.id,
    policy: tableAccess.json,
  });

  // API ハンドラ Lambda。apps/api の esbuild 出力（dist/index.js）を zip にしたもの
  const apiFn = new LambdaFunction(scope, "api", {
    functionName: "race-api",
    handler: "index.handler",
    runtime: "nodejs20.x",
    role: role.arn,
    filename: "../apps/api/dist/index.zip",
    environment: { variables: { TABLE: props.table.name } },
  });

  const httpApi = new Apigatewayv2Api(scope, "httpApi", {
    name: "race-api",
    protocolType: "HTTP",
  });

  new Apigatewayv2Stage(scope, "httpApiDefault", {
    apiId: httpApi.id,
    name: "$default",
    autoDeploy: true,
  });

  const integration = new Apigatewayv2Integration(scope, "apiIntegration", {
    apiId: httpApi.id,
    integrationType: "AWS_PROXY",
    integrationUri: apiFn.invokeArn,
    payloadFormatVersion: "2.0",
  });

  // GET /races/{id} と GET /races は getRaces、POST /results は postResult
  // （Lambda 内のルーティングは apps/api/src/index.ts）
  new Apigatewayv2Route(scope, "getRaces", {
    apiId: httpApi.id,
    routeKey: "GET /races/{id}",
    target: `integrations/${integration.id}`,
  });
  new Apigatewayv2Route(scope, "listRaces", {
    apiId: httpApi.id,
    routeKey: "GET /races",
    target: `integrations/${integration.id}`,
  });
  new Apigatewayv2Route(scope, "postResult", {
    apiId: httpApi.id,
    routeKey: "POST /results",
    target: `integrations/${integration.id}`,
  });

  new LambdaPermission(scope, "apiInvoke", {
    statementId: "AllowHttpApiInvoke",
    action: "lambda:InvokeFunction",
    functionName: apiFn.functionName,
    principal: "apigateway.amazonaws.com",
    sourceArn: `${httpApi.executionArn}/*/*`,
  });

  return { apiFn, httpApi };
}
