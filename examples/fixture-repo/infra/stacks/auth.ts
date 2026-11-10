import { CognitoUserPool } from "@cdktf/provider-aws/lib/cognito-user-pool";
import { CognitoUserPoolClient } from "@cdktf/provider-aws/lib/cognito-user-pool-client";
import type { TerraformStack } from "cdktf";

export function createAuth(scope: TerraformStack) {
  const userPool = new CognitoUserPool(scope, "admins", {
    name: "race-admins",
    autoVerifiedAttributes: ["email"],
  });

  new CognitoUserPoolClient(scope, "adminsWebClient", {
    name: "race-web",
    userPoolId: userPool.id,
    generateSecret: false,
    allowedOauthFlows: ["code"],
    allowedOauthScopes: ["openid", "email"],
    callbackUrls: ["https://races.example.com/login"],
  });

  return { userPool };
}
