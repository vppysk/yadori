import { createNextRouteHandler } from "@mastra/next";
import { mastra } from "@/mastra";

// Mastraの全HTTP API（/api/mastra/*）。画面ごとの専用APIは別途 route handler で作る
export const { GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD } = createNextRouteHandler({
  mastra,
  prefix: "/api/mastra",
});
