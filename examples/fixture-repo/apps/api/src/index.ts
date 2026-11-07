import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { getRaces } from "./handlers/getRaces";
import { postResult } from "./handlers/postResult";

// API Gateway の route_key（infra/stacks/api.ts）と同じキーで振り分ける
const routes: Record<string, APIGatewayProxyHandlerV2> = {
  "GET /races": getRaces,
  "GET /races/{id}": getRaces,
  "POST /results": postResult,
};

export const handler: APIGatewayProxyHandlerV2 = async (event, context, callback) => {
  const target = routes[event.routeKey];
  if (!target) return { statusCode: 404, body: '{"ok":false,"error":"not found"}' };
  return target(event, context, callback);
};
