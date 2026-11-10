import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { EntryInput, type ApiResponse, type RaceResult } from "@race/types";
import type { RaceItem } from "../db/schema";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE!;

const ok = <T>(data: T) => ({
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ok: true, data } satisfies ApiResponse<T>),
});

const toItem = (input: EntryInput): RaceItem => ({
  pk: "RACE#" + input.raceId,
  sk: "RESULT#" + String(input.rank).padStart(5, "0"),
  runner: input.runner,
  time: input.time,
});

// POST /results
export const postResult: APIGatewayProxyHandlerV2 = async (e) => {
  const input = EntryInput.parse(JSON.parse(e.body ?? "{}"));
  await ddb.send(new PutCommand({ TableName: TABLE, Item: toItem(input) }));
  const result: RaceResult = { ...input };
  return ok(result);
};
