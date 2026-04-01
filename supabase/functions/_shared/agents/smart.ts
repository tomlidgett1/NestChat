import type { AgentConfig } from "../orchestrator/types.ts";
import { TASK_MODE_LAYER } from "./mode-task.ts";

export const smartAgent: AgentConfig = {
  name: "smart",
  modelTier: "agent",
  maxOutputTokens: 8192,
  toolPolicy: {
    allowedNamespaces: [
      "memory.read",
      "memory.write",
      "email.read",
      "email.write",
      "calendar.read",
      "calendar.write",
      "contacts.read",
      "granola.read",
      "web.search",
      "knowledge.search",
      "messaging.react",
      "messaging.effect",
      "media.generate",
      "travel.search",
      "weather.search",
      "reminders.manage",
      "notifications.watch",
    ],
    blockedNamespaces: ["admin.internal"],
    maxToolRounds: 8,
  },
  instructions: TASK_MODE_LAYER,
};
