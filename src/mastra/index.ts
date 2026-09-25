import { Mastra } from "@mastra/core/mastra";
import { conciergeAgent } from "./agents/concierge";

export const mastra = new Mastra({
  agents: { concierge: conciergeAgent },
});
