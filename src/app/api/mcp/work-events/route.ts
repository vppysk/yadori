import { toFetchResponse, toReqRes } from "fetch-to-node";
import { workEventsMcpServer } from "@/mcp/work-events-server";

// 実績の出力口（MCP、Streamable HTTP）。EXPORT_MCP_TOKEN のBearerトークンが必要
async function handle(request: Request): Promise<Response> {
  const token = process.env.EXPORT_MCP_TOKEN;
  if (!token || request.headers.get("authorization") !== `Bearer ${token}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { req, res } = toReqRes(request);
  await workEventsMcpServer.startHTTP({ url: new URL(request.url), httpPath: "/api/mcp/work-events", req, res });
  return toFetchResponse(res);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
