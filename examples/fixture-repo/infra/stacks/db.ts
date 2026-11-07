import { DynamodbTable } from "@cdktf/provider-aws/lib/dynamodb-table";
import type { TerraformStack } from "cdktf";

export function createDb(scope: TerraformStack) {
  const table = new DynamodbTable(scope, "racesTable", {
    name: "race-results",
    hashKey: "pk",
    rangeKey: "sk",
    billingMode: "PAY_PER_REQUEST",
    attribute: [
      { name: "pk", type: "S" },
      { name: "sk", type: "S" },
    ],
  });

  return { table };
}
