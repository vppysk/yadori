import { toFetchResponse, toReqRes } from "fetch-to-node";
import { pmsMcpServer } from "@/mcp/pms-server";

// モックの予約・客室管理システムをMCP（Streamable HTTP）で公開する。PMS_MCP_TOKEN のBearerトークンが必要
async function handle(request: Request): Promise<Response> {
  const token = process.env.PMS_MCP_TOKEN;
  if (!token || request.headers.get("authorization") !== `Bearer ${token}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { req, res } = toReqRes(request);
  await pmsMcpServer.startHTTP({ url: new URL(request.url), httpPath: "/api/mcp/pms", req, res });
  return toFetchResponse(res);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
