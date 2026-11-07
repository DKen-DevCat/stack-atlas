import { App, TerraformStack } from "cdktf";
import { AwsProvider } from "@cdktf/provider-aws/lib/provider";
import type { Construct } from "constructs";
import { createDb } from "./stacks/db";
import { createAuth } from "./stacks/auth";
import { createApi } from "./stacks/api";
import { createWeb } from "./stacks/web";
import { createEdge } from "./stacks/edge";
import { createCdn } from "./stacks/cdn";

/**
 * 1 スタック（`web`）に全リソースを置く。stacks/*.ts は同じスタックに
 * リソースを足す関数で、construct path は `web/<construct id>` になる。
 */
class WebStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new AwsProvider(this, "aws", { region: "ap-northeast-1" });
    // Lambda@Edge は us-east-1 にしか置けない
    const usEast1 = new AwsProvider(this, "awsUsEast1", {
      alias: "us_east_1",
      region: "us-east-1",
    });

    const db = createDb(this);
    const auth = createAuth(this);
    const api = createApi(this, { table: db.table });
    const web = createWeb(this, { apiEndpoint: api.httpApi.apiEndpoint });
    const edge = createEdge(this, { provider: usEast1, userPool: auth.userPool });
    createCdn(this, { nextUrl: web.nextUrl, authEdge: edge.authEdge });
  }
}

const app = new App();
new WebStack(app, "web");
app.synth();
