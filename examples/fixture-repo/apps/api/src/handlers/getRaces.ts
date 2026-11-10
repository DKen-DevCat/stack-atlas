import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import type { ApiResponse, Race } from "@race/types";
import type { RaceItem } from "../db/schema";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE!;

const ok = <T>(data: T) => ({
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ok: true, data } satisfies ApiResponse<T>),
});

const toRace = (item: RaceItem): Race => ({
  id: item.pk.replace("RACE#", ""),
  name: item.name ?? "",
  date: item.date ?? "",
  venue: item.venue ?? "",
});

// GET /races/{id} -> 1 レース分（META + RESULT#*）、GET /races -> 一覧
export const getRaces: APIGatewayProxyHandlerV2 = async (e) => {
  const id = e.pathParameters?.id;
  const out = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": id ? "RACE#" + id : "RACES" },
    }),
  );
  const items = (out.Items ?? []) as RaceItem[];
  return ok(items.filter((i) => i.sk === "META").map(toRace));
};
