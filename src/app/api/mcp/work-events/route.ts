import { toFetchResponse, toReqRes } from "fetch-to-node";
import { workEventsMcpServer } from "@/mcp/work-events-server";
import { authenticateExportClient, exportClientContext } from "@/server/export-clients";

// 実績の出力口（MCP、Streamable HTTP）。接続元ごとのBearerトークンで接続元を特定する（外部連携の「実績の出力口」で登録）
async function handle(request: Request): Promise<Response> {
  const client = await authenticateExportClient(request.headers.get("authorization"));
  if (!client) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { req, res } = toReqRes(request);
  await exportClientContext.run(client, () => workEventsMcpServer.startHTTP({ url: new URL(request.url), httpPath: "/api/mcp/work-events", req, res }));
  return toFetchResponse(res);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
