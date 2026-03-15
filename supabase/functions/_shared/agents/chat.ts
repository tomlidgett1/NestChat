import type { AgentConfig } from "../orchestrator/types.ts";
import { CASUAL_MODE_LAYER } from "./mode-casual.ts";

export const chatAgent: AgentConfig = {
  name: "chat",
  modelTier: "fast",
  maxOutputTokens: 4096,
  toolPolicy: {
    allowedNamespaces: [
      "memory.read",
      "memory.write",
      "messaging.react",
      "messaging.effect",
      "media.generate",
      "web.search",
      "travel.search",
    ],
    blockedNamespaces: ["email.read", "email.write", "admin.internal"],
    maxToolRounds: 3,
  },
  instructions: CASUAL_MODE_LAYER,
};
