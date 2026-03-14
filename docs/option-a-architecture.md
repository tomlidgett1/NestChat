# Option A: Simplified Agent Architecture

## Current Architecture (7 agents, regex router)

```
                         ┌─────────────────┐
                         │   User Message   │
                         └────────┬────────┘
                                  │
                         ┌────────▼────────┐
                         │  Layer 0: Regex  │
                         │ Instant Casual   │
                         │  (greetings)     │
                         └────────┬────────┘
                                  │ not matched
                         ┌────────▼────────┐
                         │  Layer 1: Regex  │
                         │   Fast-Path      │
                         │  (~330 lines)    │
                         │                  │
                         │ • pending action │
                         │ • follow-ups     │
                         │ • email regex    │
                         │ • calendar regex │
                         │ • granola regex  │
                         │ • contacts regex │
                         │ • recall regex   │
                         │ • research regex │
                         └────────┬────────┘
                                  │ not matched
                         ┌────────▼────────┐
                         │  Layer 2: LLM    │
                         │  Router (nano)   │
                         └────────┬────────┘
                                  │
              ┌───────┬───────┬───┴───┬────────┬──────────┬──────────┐
              ▼       ▼       ▼       ▼        ▼          ▼          ▼
          ┌───────┐┌──────┐┌──────┐┌──────┐┌────────┐┌─────────┐┌───────┐
          │casual ││prod. ││rsrch ││recall││meeting ││operator ││onboard│
          │       ││      ││      ││      ││ prep   ││         ││       │
          │ fast  ││agent ││ fast ││agent ││ agent  ││ agent   ││ fast  │
          │no reas││med   ││no rea││med   ││ med    ││ med     ││no reas│
          └───────┘└──────┘└──────┘└──────┘└────────┘└─────────┘└───────┘

          Problems:
          ✗ Regex router is brittle, 330+ lines, constant edge cases
          ✗ fast tier (no reasoning) = agents don't call tools
          ✗ modelTierOverride downgrades agent tier at runtime
          ✗ 7 agents with overlapping tool access
          ✗ Router predicts tool needs before agent sees message
```

---

## Proposed Architecture (2 agents, LLM classifier)

```
                         ┌─────────────────┐
                         │   User Message   │
                         └────────┬────────┘
                                  │
                         ┌────────▼────────┐
                         │  Layer 0: Regex  │
                         │  Instant Casual  │
                         │  (greetings,     │
                         │   thanks, lol)   │
                         └───┬─────────┬───┘
                     matched │         │ not matched
                             │         │
                             ▼         ▼
                             │  ┌──────────────┐
                             │  │  LLM Classify │
                             │  │  (gpt-5-nano) │
                             │  │              │
                             │  │  Returns:    │
                             │  │  • mode      │
                             │  │  • domain    │
                             │  │  • flags     │
                             │  └──────┬───────┘
                             │         │
                             │         │ Returns one of:
                             │         │
                             │    ┌────┴─────────────────────────┐
                             │    │                              │
                             ▼    ▼                              ▼
                    ┌─────────────────┐                ┌─────────────────┐
                    │   CHAT AGENT    │                │   SMART AGENT   │
                    │                 │                │                 │
                    │  gpt-4.1-mini   │                │    gpt-5.2      │
                    │  reasoning: low │                │  reasoning: med │
                    │                 │                │                 │
                    │  Tools:         │                │  Tools:         │
                    │  • web_search   │                │  (filtered by   │
                    │  • remember_user│                │   domain tag)   │
                    │  • send_reaction│                │                 │
                    │  • send_effect  │                │  See tool       │
                    │                 │                │  filtering      │
                    │  For:           │                │  below ▼        │
                    │  • banter       │                │                 │
                    │  • greetings    │                │  For:           │
                    │  • emotional    │                │  • email        │
                    │  • opinions     │                │  • calendar     │
                    │  • simple Q&A   │                │  • meetings     │
                    │  • chitchat     │                │  • research     │
                    │                 │                │  • recall       │
                    └─────────────────┘                │  • contacts     │
                                                      │  • complex ops  │
                                                      │  • onboarding   │
                                                      └────────┬────────┘
                                                               │
                                                      ┌────────▼────────┐
                                                      │  Dynamic Tool   │
                                                      │   Filtering     │
                                                      └────────┬────────┘
                                                               │
                      ┌──────────┬──────────┬─────────┬────────┴───────┐
                      ▼          ▼          ▼         ▼                ▼
                 ┌─────────┐┌────────┐┌─────────┐┌────────┐   ┌────────────┐
                 │  email  ││calendar││ meeting ││research│   │  recall /  │
                 │  tools  ││ tools  ││  prep   ││ tools  │   │  memory    │
                 │         ││        ││  tools  ││        │   │  tools     │
                 │email_   ││cal_    ││cal_read ││web_    │   │semantic_   │
                 │ read    ││ read   ││email_   ││ search │   │ search     │
                 │email_   ││cal_    ││ read    ││        │   │granola_    │
                 │ draft   ││ write  ││granola_ ││        │   │ read       │
                 │email_   ││        ││ read    ││        │   │remember_   │
                 │ send    ││        ││contacts_││        │   │ user       │
                 │email_   ││        ││ read    ││        │   │            │
                 │ update  ││        ││semantic_││        │   │            │
                 │contacts_││        ││ search  ││        │   │            │
                 │ read    ││        ││web_     ││        │   │            │
                 │         ││        ││ search  ││        │   │            │
                 └─────────┘└────────┘└─────────┘└────────┘   └────────────┘
```

---

## LLM Classifier Output

The nano classifier replaces both the regex fast-path and the current LLM router.
It returns a lightweight JSON object:

```
{
  "mode": "chat" | "smart",
  "domain": "email" | "calendar" | "meeting_prep" | "research" | "recall" | "contacts" | "general",
  "flags": {
    "needs_web": true/false,
    "needs_memory": true/false,
    "is_confirmation": true/false,
    "pending_action_id": "draft_123" | null
  },
  "style": "brief" | "normal" | "deep"
}
```

---

## How Domain Maps to Tools (Smart Agent)

```
 domain            tools provided               tool_choice
 ──────            ───────────────              ───────────
 email          →  email_*, contacts_read    →  auto
 calendar       →  calendar_*, contacts_read →  auto
 meeting_prep   →  calendar_read, email_read,
                   granola_read, contacts_read,
                   semantic_search, web_search → auto
 research       →  web_search               →  required (if needs_web)
 recall         →  semantic_search,
                   granola_read              →  required
 contacts       →  contacts_read            →  required
 general        →  all tools                →  auto
```

---

## How Prompts Work (Smart Agent)

Instead of 7 separate agent instruction files, the smart agent
composes its prompt dynamically:

```
 ┌──────────────────────────────────────────────┐
 │  System Prompt                               │
 │                                              │
 │  ┌────────────────────────────────────────┐  │
 │  │  Layer 1: Identity (base-instructions) │  │
 │  │  (same as today, shared across all)    │  │
 │  └────────────────────────────────────────┘  │
 │                                              │
 │  ┌────────────────────────────────────────┐  │
 │  │  Layer 2: Domain Instructions          │  │
 │  │                                        │  │
 │  │  IF domain = "email":                  │  │
 │  │    inject email rules, draft flow,     │  │
 │  │    presentation format                 │  │
 │  │                                        │  │
 │  │  IF domain = "meeting_prep":           │  │
 │  │    inject briefing workflow,           │  │
 │  │    retrieval strategy, format          │  │
 │  │                                        │  │
 │  │  IF domain = "research":              │  │
 │  │    inject search-first behaviour,     │  │
 │  │    citation style                      │  │
 │  │                                        │  │
 │  │  IF domain = "recall":                │  │
 │  │    inject search strategy,            │  │
 │  │    granola fallback                    │  │
 │  │                                        │  │
 │  │  (etc.)                                │  │
 │  └────────────────────────────────────────┘  │
 │                                              │
 │  ┌────────────────────────────────────────┐  │
 │  │  Layer 3: Context                      │  │
 │  │  (memory, accounts, RAG, summaries)    │  │
 │  └────────────────────────────────────────┘  │
 │                                              │
 │  ┌────────────────────────────────────────┐  │
 │  │  Layer 4: Turn                         │  │
 │  │  (time, group chat, platform, etc.)    │  │
 │  └────────────────────────────────────────┘  │
 │                                              │
 └──────────────────────────────────────────────┘
```

---

## Key Differences Summary

```
 Aspect              Current                  Option A
 ──────              ───────                  ────────
 Agents              7                        2 (chat + smart)
 Router              330-line regex +         10-line regex (greetings)
                     LLM fallback             + LLM classifier
 Model tiers         fast (no reasoning)      fast (low reasoning)
                     + agent (med reasoning)  + agent (med reasoning)
 Tool selection      Router predicts tools    Agent decides tools
                     via regex                (filtered by domain)
 modelTierOverride   Yes (breaks agents)      No (agent owns its tier)
 Tool count per      8-13 tools always        3-6 tools per domain
  request            available                (less noise, better picks)
 Confirm handling    Aggressive regex +       Classifier flag +
                     LLM classifier           state verification
 Prompt strategy     7 separate instruction   1 base + domain blocks
                     files                    injected dynamically
 Web search          Hopes model will search  tool_choice: required
                                              when needs_web = true
```

---

## Data Flow: Example Messages

### "Check my latest emails"

```
 Current:  regex "email" ✓ → regex "latest" triggers needsResearch
           → routes to OPERATOR (wrong) → gpt-5.2 with 13 tools

 Option A: classifier → { mode: "smart", domain: "email" }
           → SMART AGENT with email tools only (5 tools)
           → gpt-5.2 calls email_read naturally
```

### "What's the weather in Melbourne?"

```
 Current:  regex "weather" triggers isWorldKnowledge
           → routes to RESEARCH → gpt-4.1-mini (no reasoning)
           → model answers from training data, doesn't search

 Option A: classifier → { mode: "smart", domain: "research", needs_web: true }
           → SMART AGENT with web_search only
           → tool_choice: required → model MUST search
```

### "Prep me for my next meeting"

```
 Current:  regex checks meeting_prep pattern ✓
           BUT if previous test left pending draft state,
           confirm classifier intercepts → routes to PRODUCTIVITY

 Option A: classifier → { mode: "smart", domain: "meeting_prep" }
           → no confirm interception (flag-based, checks real state)
           → SMART AGENT with meeting prep tools
```

### "hey"

```
 Current:  Layer 0 instant casual ✓ → CASUAL agent → gpt-4.1-mini

 Option A: Layer 0 instant casual ✓ → CHAT agent → gpt-4.1-mini
           (identical, no change needed)
```

### "Who is Daniel Barth?"

```
 Current:  regex misses "who is" for contacts
           → falls to research regex ("who is") ✓
           → RESEARCH agent → gpt-4.1-mini → web_search (wrong)

 Option A: classifier → { mode: "smart", domain: "contacts" }
           → SMART AGENT with contacts_read only
           → tool_choice: required → checks contacts first
           → if not found, falls back to web_search
```
