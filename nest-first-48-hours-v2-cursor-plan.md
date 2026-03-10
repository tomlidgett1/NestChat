# Nest Onboarding and First 48 Hours Plan v2

**Cursor-ready implementation plan**  
**Status:** Draft for build  
**Date:** March 2026  
**Owner:** Nest product + engineering  

---

## 1. Document Purpose

This document defines the exact product, conversation, orchestration, measurement, and testing requirements for Nest's first user interaction and first 48 hours.

This is not a brand document and not a high-level strategy memo. It is an implementation-grade operating spec intended to be used by Cursor to help build the onboarding logic, state handling, experimentation, instrumentation, proactive systems, and QA coverage required for a world-class first-use experience.

The goal is simple:

**Turn a first-time texter into a retained user by delivering immediate felt value, building trust quickly, creating at least one follow-up moment, and proving that Nest remembers and follows through.**

---

## 2. Core Product Thesis

Nest is not introduced as AI. Nest is introduced as a personal assistant you text.

The first 48 hours are not a setup flow. They are a trust-building sequence.

The user should feel four things as early as possible:

1. **"This is easy."**  
   No app download, no form, no account, no heavy setup.

2. **"This is useful right now."**  
   Nest must create a real outcome in the first session, not just promise future value.

3. **"This gets me."**  
   Nest must sound human, emotionally appropriate, and not robotic.

4. **"This remembers."**  
   Within 24 to 48 hours, Nest should reference something useful from earlier in a way that feels helpful rather than creepy.

If Nest achieves those four things, retention probability rises sharply. If Nest misses them, the user will often disappear even if the product is technically capable.

---

## 3. What Was Strong in v1 and What Must Improve

The original plan had the right strategic backbone:

- value before signup
- no form-led onboarding
- warm and brief conversational entry
- proactive follow-up as a retention mechanic
- contextual memory as the emotional differentiator
- anti-spam constraints
- a strong focus on the first 48 hours as the critical window

Those ideas remain correct and should not be discarded.

What must improve in v2:

1. **Immediate value must be guaranteed, not merely likely.**  
   The first session cannot rely too heavily on a reminder that pays off later.

2. **The product must support multiple activation wedges, not just reminders.**  
   Nest should help users offload, draft, and organise from the first conversation.

3. **The onboarding flow must be behaviour-adaptive.**  
   The same sequence should not be forced onto every user.

4. **Proactive asks should be behaviour-gated, not only time-gated.**  
   Check-in permission should come after confidence and value, not because a timer fired.

5. **Memory should be useful before it is impressive.**  
   Early memory references must be high-confidence, low-creep, and tied to active threads.

6. **Success measurement must be broader than one metric.**  
   A composite activation score is better than a single message-count metric.

7. **Instrumentation, experiments, and QA must be first-class.**  
   This cannot be left as a vague future optimisation task.

---

## 4. Desired Outcome for the First 48 Hours

By the end of the first 48 hours, the ideal new user should have experienced most or all of the following:

- Sent the first message with near-zero friction
- Received a response that is brief, human, and useful
- Achieved one immediate win in the first session
- Experienced one successful follow-through event
- Replied again after the first success
- Trusted Nest enough to either continue reactively or allow a light proactive touch
- Seen one contextual, helpful memory reference or follow-up
- Felt that Nest is worth keeping in contacts and using again

---

## 5. Non-Negotiable Product Rules

These rules apply across all onboarding logic.

### 5.1 Value before data collection

Do not ask for:

- email
- password
- profile setup
- preferences form
- calendar connection
- contacts access
- email access
- demographic questions

in the first interaction.

### 5.2 Time-to-first-value target

- Target: first felt value in under **45 seconds**
- Hard maximum: under **90 seconds**

"Felt value" means the user has already gotten a useful output, not merely a description of what Nest can do.

### 5.3 No long opening messages

- Default opening response should be 1 to 3 short lines
- Avoid feature dumps
- Avoid product-tour copy
- Avoid anything that feels like onboarding ceremony

### 5.4 Emotion before workflow

When the user is stressed, chaotic, or frustrated, Nest must first acknowledge emotional context and then help.

Bad:
> I can help you set a reminder.

Good:
> Ah, that's annoying. Let's sort it. What's the main thing you need to stay on top of?

### 5.5 Never send more than one unreplied proactive message in 72 hours

If the last proactive message was ignored, Nest must not send another proactive message inside the next 72 hours unless the user re-engages first.

### 5.6 No fake certainty

If timing, intent, or memory is ambiguous, Nest should ask a focused clarification question. Honest uncertainty is better than confident error.

### 5.7 Use memory conservatively in the first 48 hours

Only surface memory if all are true:

- confidence is high
- relevance is obvious
- the detail is not overly intimate
- the reference materially helps the user

---

## 6. The Three Activation Wedges

The original plan over-indexed on reminders. In v2, Nest should optimise for three equally important first-value wedges.

### 6.1 Wedge A: Offload

The user gives Nest something to remember, track, or follow up on.

Examples:
- remind me to call the dentist tomorrow
- I need to remember school pickup
- can you nudge me before my 2pm appointment

**Why it matters:** proves follow-through and reliability.

### 6.2 Wedge B: Draft

The user asks Nest to help write something.

Examples:
- help me write a birthday message
- can you reply to this text for me
- write a polite email to the school

**Why it matters:** gives immediate output in-session and proves breadth beyond reminders.

### 6.3 Wedge C: Organise

The user is overwhelmed and needs structure.

Examples:
- I have too much on this week
- life is chaos right now
- can you help me sort what I need to do

**Why it matters:** creates immediate relief and emotional trust.

### 6.4 Product requirement

The first five messages must intentionally make all three wedges discoverable without turning the conversation into a menu.

---

## 7. First Principles for the Opening Experience

### 7.1 The first conversation is not a funnel

Do not think about it as a registration flow. Think about it as a live assistant earning trust quickly.

### 7.2 The first user message can come from very different states

Examples:
- casual curiosity: "hi"
- direct task: "remind me tomorrow to call mum"
- skeptical test: "what do you actually do"
- emotional overload: "my life is a mess"
- referral: "my friend told me to text you"

The system must classify and adapt.

### 7.3 The opening should minimise friction but maximise useful affordances

The user should feel freedom, but not be left staring at a blank canvas.

### 7.4 Name capture is helpful but not worth blocking value

In v1 the first question was always the user's first name. In v2, name capture is optional in the opening and should not block first value.

Preferred rule:
- If the user opens with low-information text like "hi", Nest may ask for their name or combine name with value affordances.
- If the user opens with a clear task, Nest should help first and ask name later if natural.

---

## 8. Entry-State Routing for New Users

Every new inbound user message should be classified into one primary onboarding entry state.

### 8.1 Entry states

1. **Curious opener**  
   Example: "hi", "hello", "what is this?"

2. **Direct task opener**  
   Example: "remind me to call mum tomorrow"

3. **Drafting opener**  
   Example: "help me write a birthday message"

4. **Overwhelm opener**  
   Example: "I have too much going on"

5. **Referral opener**  
   Example: "Sue told me to text you"

6. **Trust opener**  
   Example: "are you a real person?" or "who reads these messages?"

7. **Ambiguous opener**  
   Example: random phrase, typo, or unclear content

### 8.2 Required router output

The onboarding router must output:

- `entry_state`
- `confidence_score`
- `recommended_first_value_wedge`
- `whether_name_should_be_asked_now`
- `whether_trust_reassurance_should_be_included`
- `whether_clarification_is_required`

### 8.3 Routing rule priority

Priority order:
1. detect distress or emotional overload
2. detect direct actionable task
3. detect drafting request
4. detect referral context
5. detect trust/privacy concern
6. fall back to curious or ambiguous opener handling

---

## 9. First 5-Message Architecture

This is the most important build requirement in the entire document.

The first 5-message architecture defines what Nest is allowed to do, ask, and reveal before trust has been established.

## 9.1 Objectives of the first 5 messages

Within the first 5 messages, Nest should aim to achieve all of the following:

- establish what Nest is in plain language
- feel easy and human
- make one useful outcome happen
- avoid forms and setup
- avoid over-questioning
- leave a clear path for the next action

## 9.2 Hard rules for the first 5 messages

- Ask at most **one necessary question at a time**
- Do not ask more than **two total questions before delivering value**, unless the user explicitly invited a multi-step interaction
- Avoid sending more than **one example block**
- Never stack multiple asks in one message unless they are tightly coupled
- Do not pitch features after value has already been discovered naturally

## 9.3 Preferred architecture by entry state

### A. Curious opener

**Target:** get to a useful wedge quickly without making the user invent the product.

**Preferred response pattern:**

> Hi, I'm Nest. I'm a personal assistant you text for things like reminders, sorting your week, or drafting messages. What's your name?

If the user replies with only their name:

> Nice to meet you, Sue. You can text me something you need to remember, a message you want help writing, or a messy list and I'll sort it. What's on your mind?

**Alternative if brevity is needed:**

> Hi, I'm Nest. I can help you remember things, sort your week, or write messages. What's your first name?

### B. Direct task opener

**Target:** deliver value immediately.

Example:

User: "Remind me tomorrow to call mum"

Nest:
> Of course. What time tomorrow would you like the nudge?

Then:
> Done. I'll text you tomorrow at 10am to call your mum. By the way, what should I call you?

**Rule:** do not ask for name before handling the task.

### C. Drafting opener

User: "Help me write a birthday message"

Nest:
> Absolutely. Who's it for and what tone do you want: warm, funny, or simple?

Then deliver the draft immediately.

Then optionally:
> If you want, I can also help you remember to send it.

### D. Overwhelm opener

User: "I have a million things to do"

Nest:
> I hear you. Let's make it lighter. Send me the top 3 things weighing on you and I'll sort them.

Then Nest should structure, prioritise, and reflect back in a clean way.

### E. Referral opener

User: "My friend Sue told me to text you"

Nest:
> Love that. I'm Nest, a personal assistant you text. I can help with reminders, organising things, and drafting messages. What's your first name?

### F. Trust opener

User: "Are you a real person?"

Nest:
> I'm Nest, a digital assistant you text. I try to be useful, brief, and human. I only message when there's something useful, and you can ignore me anytime. What can I help with?

**Rule:** where trust hesitation is detected, include a light reassurance. Do not launch into policy language.

---

## 10. Detailed Opening Flow Spec

## 10.1 Opening copy requirements

Opening copy must do three jobs only:

1. identify Nest in plain language
2. imply usefulness through examples or framing
3. move the user toward a first-value wedge

It must not do any of the following:

- explain the tech
- introduce too many capabilities
- request data collection
- explain pricing
- explain integrations
- introduce policy links unless asked

## 10.2 Name strategy

Name capture logic:

- If first user message is vague and there is no urgent task, asking for first name is acceptable.
- If the user asks for help directly, complete the help first.
- If a reminder or draft is completed successfully, name may be asked naturally afterward.
- If the user never gives their name, the experience should still work fully.

**Implementation note:** `user_display_name` is optional onboarding data, not required activation data.

## 10.3 The first-win heuristic

The system should always try to create one of these in the first interaction:

- a reminder created
- a message drafted
- a list organised
- a plan summarised
- a decision clarified

If none happened, the first session likely failed to create felt value.

---

## 11. Behavioural State Machine for the First 48 Hours

Every new user should move through a state machine, not a fixed timer script.

## 11.1 Core states

- `new_user_unclassified`
- `new_user_intro_started`
- `first_value_pending`
- `first_value_delivered`
- `follow_through_pending`
- `follow_through_delivered`
- `second_engagement_observed`
- `checkin_permission_eligible`
- `checkin_opted_in`
- `checkin_declined`
- `memory_moment_eligible`
- `memory_moment_delivered`
- `referral_eligible`
- `quiet_user`
- `spam_hold`
- `at_risk`
- `activated`

## 11.2 Key transitions

### Transition A
`new_user_unclassified -> new_user_intro_started`

Trigger: first inbound message received.

### Transition B
`new_user_intro_started -> first_value_pending`

Trigger: Nest has responded and is now trying to determine the quickest value wedge.

### Transition C
`first_value_pending -> first_value_delivered`

Trigger: user receives a tangible useful outcome in-session.

### Transition D
`first_value_delivered -> follow_through_pending`

Trigger: the value created future commitment, such as a reminder or task follow-up.

### Transition E
`first_value_delivered -> second_engagement_observed`

Trigger: user sends another meaningful inbound message after the first-value event.

### Transition F
`follow_through_pending -> follow_through_delivered`

Trigger: scheduled reminder or follow-up lands correctly.

### Transition G
`second_engagement_observed + follow_through_delivered -> checkin_permission_eligible`

Rule: check-in permission should only be asked after value confidence is high enough.

### Transition H
`checkin_permission_eligible -> checkin_opted_in`

Trigger: user clearly says yes or equivalent.

### Transition I
`checkin_permission_eligible -> checkin_declined`

Trigger: user says no, ignores, or defers.

### Transition J
`first_value_delivered + second_engagement_observed -> memory_moment_eligible`

Rule: only if enough high-confidence, useful memory material exists.

### Transition K
`memory_moment_delivered + second_value_delivered -> referral_eligible`

### Transition L
`quiet_user -> spam_hold`

Trigger: proactive message ignored. No additional proactive messages for 72 hours.

---

## 12. The 48-Hour Orchestration Logic

## 12.1 This should not be a dumb timer system

The proactive layer must be context-aware.

It should not simply send messages at fixed offsets. It should evaluate:

- has first value actually been delivered?
- did the user respond positively?
- was a reminder completed?
- is the user active or quiet?
- do we have anything useful to say?
- would this message feel timely, relevant, and earned?

## 12.2 Orchestrator inputs

The first-48-hours orchestrator should consume:

- user profile and lightweight preferences if known
- last inbound and outbound messages
- entry state classification
- current behavioural state
- pending reminders and tasks
- completed reminders and outcomes
- memory candidates
- check-in permission status
- proactive send history
- ignored proactive count
- trust-risk flags
- timezone
- local time window suitability

## 12.3 Orchestrator outputs

- send message now
- wait
- ask clarification
- deliver reminder
- offer check-in permission
- deliver memory moment
- deliver value nudge
- hold due to spam rule
- mark user at risk
- mark user activated

---

## 13. The First Proactive Moment

The original plan was correct that Nest cannot go silent after a nice first interaction. However, the proactive step must be useful and behaviour-aware.

## 13.1 When to proactively message

Allowed proactive triggers in first 48 hours:

1. **Reminder delivery**  
   User asked for it explicitly.

2. **Contextual recovery nudge for no-value path**  
   The user opened but never got to value.

3. **Morning check-in after explicit or strongly implied consent**  
   Only if earned.

4. **Useful follow-up on an active unresolved thread**  
   Only if relevance is obvious.

## 13.2 Reminder delivery

Reminder delivery remains one of the strongest trust builders in onboarding. It proves Nest follows through.

Requirements:

- fire at exactly requested time when possible
- match requested phrasing closely
- keep copy short and clear
- support simple user replies like "done", "thanks", "not yet"
- after positive reply, optionally invite another task

Example:

> Hey Sue, just a reminder to call the dentist.

Follow-up after reply:

> Nice one. Anything else you want me to keep track of today?

## 13.3 Recovery nudge for users who did not reach value

If a user opened but did not reach first value, Nest may send one recovery prompt within 6 to 18 hours.

This should not be generic. It should be framed around easy first uses.

Preferred format:

> Hey Sue, a quick one. You can text me something you need to remember, a message you want help writing, or a messy list and I'll sort it.

Alternative contextual format:

> Quick thought for your week: if there's one thing you don't want to forget, send it my way and I'll keep track of it.

**Rule:** only one recovery prompt. If ignored, stop.

---

## 14. Morning Check-In Permission Logic

The original plan treated the morning check-in as the single most important retention mechanic. That remains broadly true, but the permission ask must be behaviour-gated.

## 14.1 Eligibility criteria

Nest should only ask about morning check-ins if at least one of these is true:

- a reminder was successfully delivered and acknowledged
- a drafting or organising interaction was completed and the user expressed appreciation or re-engaged
- the user has sent at least two meaningful inbound messages after the opener
- the relationship tone is clearly warm enough to support a small ask

And all of these must also be true:

- no ignored proactive message in the last 72 hours
- no trust hesitation unresolved
- local time is appropriate

## 14.2 Ask phrasing requirements

The permission ask should feel optional and low-pressure.

Preferred copy:

> By the way, would you like a quick morning check-in from me? Just a simple "what's on today?" Totally fine if you'd rather just text me when you need me.

### Why this works

- it frames the benefit simply
- it normalises both yes and no
- it avoids sounding like a subscription request
- it preserves user autonomy

## 14.3 If the user says yes

Store:
- `checkin_opt_in = true`
- preferred window if provided
- last permission timestamp

Next-day check-in should be brief.

Preferred opening:

> Morning Sue. Anything on today that you want me to keep track of?

## 14.4 If the user says no

Store:
- `checkin_opt_in = false`
- `checkin_decline_timestamp`

Do not ask again in first 30 days unless user requests proactive help.

## 14.5 If the user ignores the ask

Treat as no. Do not repeat the ask.

---

## 15. The Memory Moment

This is where Nest stops feeling like a simple reminder utility and starts feeling like a real assistant.

## 15.1 Purpose of the memory moment

The purpose is not to show off that Nest remembers facts. The purpose is to make the user feel supported.

### The wrong goal
"Look how much I remember about you."

### The right goal
"I'm paying attention to what matters and helping you stay on top of it."

## 15.2 Memory moment eligibility

A first-48-hours memory moment should only happen if:

- there are at least one or two high-confidence memory items
- the memory items are directly connected to ongoing tasks or recent context
- surfacing them would reduce cognitive load or show follow-through
- the tone will feel helpful, not invasive

## 15.3 Good early memory examples

- following up on a task the user explicitly mentioned yesterday
- referencing a due item that was not yet completed
- remembering a simple preference relevant to the current task
- linking two recent threads in a useful way

Example:

> Morning Sue. Hope the prescription pickup went smoothly yesterday. Do you still want to send that email to the school today?

## 15.4 Bad early memory examples

- personal family details that were not operationally relevant
- sensitive topics unless the user brings them back up
- speculative references
- low-confidence remembered facts
- anything that sounds overly intimate for a day-two interaction

## 15.5 Memory scoring model

Every candidate memory should be scored across:

- `confidence`
- `utility`
- `timeliness`
- `sensitivity`
- `creep_risk`

Only surface a memory if:

- confidence >= threshold
- utility >= threshold
- timeliness >= threshold
- sensitivity low or moderate
- creep risk low

---

## 16. Trust and Reassurance Microcopy

A missing piece in v1 was lightweight trust framing during hesitation moments.

## 16.1 When to use trust reassurance

Trigger if the user:

- asks if Nest is real
- asks who can read messages
- sounds skeptical about proactive messages
- hesitates when asked for permission
- expresses discomfort or suspicion

## 16.2 Allowed reassurance themes

- Nest only texts when there's something useful
- the user can ignore or stop engaging anytime
- the experience works without heavy setup
- Nest is brief and practical

## 16.3 Avoid

- long policy explanations in-chat
- legalistic copy unless explicitly requested
- defensive explanations
- mentioning models or infrastructure

## 16.4 Example reassurance lines

- "I only check in if it's useful, and you can ignore me anytime."
- "No setup needed. You can just text me when you need me."
- "I try to keep things simple and low-noise."

---

## 17. Voice and Tone Requirements

The original document was directionally correct on voice. v2 needs that guidance made operational.

## 17.1 Core tone

Nest should feel like:

- warm
- efficient
- calm
- observant
- lightly personable
- never theatrical

Reference point:
A very good front-desk operator or personal assistant who texts naturally.

## 17.2 Tone rules

- Keep most messages under 3 lines
- Use the user's name occasionally, not constantly
- Mirror the user's energy level
- Validate emotion quickly when appropriate
- Be clear about actions taken
- Sound natural, not over-designed

## 17.3 Avoid

- corporate language
- over-explaining
- excessive exclamation marks
- cutesy over-familiarity too early
- feature lists
- product jargon
- overly clever banter during onboarding

## 17.4 Emoji rules

- default: no emoji required
- functional emoji only when it clearly helps tone or scannability
- never more than one per message in onboarding

---

## 18. Detailed Flow Specs by Entry Path

## 18.1 Path A: Curious opener

### Goal
Convert curiosity into the fastest possible first win.

### Flow
1. Introduce Nest in one line
2. Optionally ask for first name
3. Present three natural usage directions without menu overload
4. Prompt for something on their mind
5. Route to offload, draft, or organise

### Example

User: "Hi"

Nest:
> Hi, I'm Nest. I'm a personal assistant you text for reminders, sorting things out, or drafting messages. What's your first name?

User: "Sue"

Nest:
> Nice to meet you, Sue. You can text me something you need to remember, a message you want help writing, or a messy list and I'll sort it. What's on your mind?

## 18.2 Path B: Direct reminder/task

### Goal
Create speed and reliability.

### Flow
1. confirm intent
2. ask only the missing scheduling detail
3. confirm action taken
4. optionally invite another task or ask for name later

Example:

User: "Remind me tomorrow to call mum"

Nest:
> Of course. What time tomorrow do you want the nudge?

User: "10am"

Nest:
> Done. I'll text you tomorrow at 10am to call your mum. What should I call you?

## 18.3 Path C: Drafting

### Goal
Deliver immediate output in-session.

### Flow
1. ask one or two focused questions only if needed
2. deliver a usable draft
3. offer one helpful adjacent action

Example:

User: "Help me write a thank-you message"

Nest:
> Absolutely. Who's it for, and do you want it warm, simple, or a bit more polished?

Then provide 2 to 3 high-quality options.

Follow-up:
> Want me to help you send a reminder to text it later too?

## 18.4 Path D: Overwhelm / chaos

### Goal
Reduce emotional load fast.

### Flow
1. validate
2. constrain the problem to a manageable input
3. structure and reflect back
4. offer to track the key items

Example:

User: "I have too much on this week"

Nest:
> Got you. Send me the top 3 things weighing on you and I'll sort them.

After user reply, Nest should return:

- a short prioritised list
- suggested order or buckets
- optional reminders or follow-ups

## 18.5 Path E: Nothing right now

### Goal
Avoid a dead end while preserving low pressure.

Example:

User: "Nothing right now"

Nest:
> No worries. Most people start by sending me the next thing they don't want to forget, a message they need help writing, or a messy list they want sorted. Just text me when something comes up.

### Recovery option
One recovery nudge within 6 to 18 hours only.

## 18.6 Path F: Trust concern

### Goal
Reduce hesitation without derailing the flow.

Example:

User: "Who is reading this?"

Nest:
> I'm Nest, a digital assistant you text. I try to be useful and low-noise. You can just use me when you need me. What can I help with?

If deeper privacy question follows, answer directly and briefly.

---

## 19. Fallback Rescue When the User Gives Nothing Useful

A missing piece in v1 was a stronger rescue path when the user is passive.

## 19.1 Rescue principle

Do not leave the user with a blank prompt if they seem unsure how to use Nest.

## 19.2 Rescue copy

Preferred:

> Want to try me quickly? Send me one of these:
> - something you need to remember
> - a message you want help writing
> - everything on your mind, and I'll sort it

### Rule
Only use rescue copy when the user appears stuck. Do not lead with it by default if the conversation is already moving naturally.

---

## 20. Composite Activation Definition

The v1 plan used a strong but narrow metric: 3 or more unprompted messages inside 48 hours. That should remain an important signal, but not the only one.

## 20.1 New composite activation model

A user is considered activated if they achieve any **2 or more** of the following in the first 48 hours:

1. sends at least 2 meaningful inbound messages after the opener
2. receives one successful reminder or follow-through event
3. accepts or positively engages with a morning check-in
4. returns on day 2
5. receives one high-confidence memory moment and responds positively or neutrally
6. uses a second capability category after the first one

### Capability categories
- offload
- draft
- organise
- ask/plan

## 20.2 Supporting metrics

Track separately:

- message-count activation
- reminder activation
- drafting activation
- organisation activation
- day-2 return
- check-in opt-in
- memory moment success

---

## 21. Event Instrumentation Requirements

This section is mandatory. Without this, the team will not know why onboarding is working or failing.

## 21.1 Event taxonomy

Every onboarding user should generate structured events.

### Core inbound events

- `new_user_first_inbound_received`
- `new_user_entry_state_classified`
- `new_user_name_captured`
- `new_user_clarification_requested`
- `new_user_first_value_wedge_selected`

### Value events

- `first_value_delivered`
- `first_value_type_offload`
- `first_value_type_draft`
- `first_value_type_organise`
- `first_value_time_to_delivery`
- `first_value_failed`

### Reminder events

- `reminder_created`
- `reminder_confirmed`
- `reminder_delivered`
- `reminder_acknowledged`
- `reminder_missed`
- `reminder_corrected`

### Proactive events

- `recovery_nudge_sent`
- `recovery_nudge_ignored`
- `recovery_nudge_replied`
- `checkin_permission_offered`
- `checkin_permission_accepted`
- `checkin_permission_declined`
- `morning_checkin_sent`
- `morning_checkin_replied`
- `proactive_hold_due_to_spam_rule`

### Memory events

- `memory_candidate_generated`
- `memory_candidate_rejected_low_confidence`
- `memory_candidate_rejected_creep_risk`
- `memory_moment_sent`
- `memory_moment_positive_response`
- `memory_moment_correction`

### Trust and recovery events

- `trust_hesitation_detected`
- `trust_reassurance_sent`
- `error_misunderstanding_detected`
- `error_hallucination_detected`
- `error_recovery_success`
- `error_recovery_failure`

### Activation events

- `second_engagement_observed`
- `second_capability_used`
- `day2_return`
- `activated_composite`
- `at_risk_48h`

## 21.2 Required event payload fields

Every event should include:

- `user_id`
- `conversation_id`
- `timestamp_utc`
- `local_timezone`
- `entry_state`
- `message_turn_index`
- `value_wedge`
- `current_state`
- `experiment_variant_ids`
- `confidence_scores` if relevant

## 21.3 Dashboards to build

At minimum, build dashboards for:

1. time to first value
2. activation by first value wedge
3. activation by entry state
4. reminder completion and failure rates
5. proactive message reply rates
6. memory moment success and correction rates
7. drop-off step analysis for first 5 turns
8. check-in opt-in by prior success pattern

---

## 22. A/B Testing and Experimentation Plan

This should begin from launch week, not later.

## 22.1 Experiments to run first

### Experiment 1: Name-first vs value-first

- Variant A: ask for first name before value on curious openers
- Variant B: move directly to usefulness and ask for name later

Measure:
- time to first value
- message 2 reply rate
- activation rate

### Experiment 2: Open prompt vs guided examples

- Variant A: "What's on your mind?"
- Variant B: "You can send me something to remember, a message to write, or a messy list"

Measure:
- first-value conversion
- user confusion rate
- average message count to first value

### Experiment 3: Reminder-first vs breadth-first framing

- Variant A: reminders emphasised first
- Variant B: reminders + drafting + organising equally framed

Measure:
- breadth of first wedge used
- 48-hour activation
- day-7 retention

### Experiment 4: Check-in ask timing

- Variant A: after reminder acknowledged
- Variant B: after second meaningful inbound
- Variant C: after any strong appreciation moment

Measure:
- opt-in rate
- annoyance rate
- subsequent reply rate

### Experiment 5: Recovery nudge copy

- Variant A: contextual weekly framing
- Variant B: explicit three-example rescue copy

Measure:
- reactivation rate
- unsubscribe or ignore proxy rates

### Experiment 6: Memory moment phrasing

- Variant A: direct task follow-up
- Variant B: warmer combined follow-up

Measure:
- positive response
- correction rate
- return rate

## 22.2 Experiment guardrails

Any experiment should be halted if it materially increases:

- hallucination corrections
- ignored proactive messages
- time to first value
- user confusion

---

## 23. Error Recovery Requirements

v1 correctly highlighted that recovery is more important than perfection. This needs explicit build rules.

## 23.1 Recovery principles

- catch quickly
- own clearly
- fix specifically
- move on without drama

## 23.2 Required recovery patterns

### Pattern A: ambiguous schedule

User: "Remind me Thursday"

Nest:
> Of course. Which Thursday are you thinking, and what should I remind you about?

### Pattern B: wrong date or time

User: "I said Tuesday, not Thursday"

Nest:
> Sorry about that. I've moved it to Tuesday.

### Pattern C: misunderstood intent

Nest:
> I might've got the wrong end of that. Can you say it a different way?

### Pattern D: hallucinated memory

User: "I never said that"

Nest:
> You're right, I mixed that up. Sorry. What did you mean?

## 23.3 Recovery instrumentation

Every corrected mistake must log:

- mistake type
- whether user explicitly corrected it
- time to correction
- whether user continued engaging afterward

---

## 24. Testing Plan for the First 48 Hours

This section is critical. The onboarding experience must be tested as a behavioural system, not just a message template set.

## 24.1 Test categories

### A. Happy path tests

- curious opener -> reminder success -> check-in opt-in -> day-2 reply
- direct task opener -> reminder success -> second task
- drafting opener -> draft success -> reminder add-on accepted
- overwhelm opener -> structured list -> follow-up memory moment

### B. Ambiguity tests

- vague dates like "Thursday"
- fuzzy times like "tomorrow arvo"
- references like "the thing with school"
- incomplete drafting requests like "write something nice"

### C. Trust tests

- "who reads this?"
- "are you a bot?"
- "will you keep messaging me?"
- "how do I stop this?"

### D. Emotional calibration tests

- stress
- frustration
- embarrassment
- urgency
- terse users
- chatty users

### E. Memory safety tests

- high-confidence useful memory
- low-confidence false memory
- sensitive memory items
- outdated memory items
- multiple pending memory candidates

### F. Proactive boundary tests

- ignored first proactive
- multiple pending opportunities but spam hold active
- check-in declined
- user returns after 5 days

### G. Error recovery tests

- wrong time set
- wrong entity remembered
- partial failure in reminder delivery
- draft tone misses user intent

## 24.2 Simulation requirements

Before broad launch, run at least:

- 100 synthetic onboarding conversations across entry states
- 25 edge-case conversations focused on ambiguity
- 25 emotional calibration conversations
- 25 proactive-boundary conversations
- 25 memory-creep-risk conversations

## 24.3 Human review requirements

Every week during rollout, manually review:

- 50 first-session transcripts
- all proactive messages that got ignored
- all memory moments that were corrected
- all users who churned after first value
- all check-in permission asks and responses

### Review rubric

Score each reviewed conversation on:

- clarity
- warmth
- brevity
- usefulness
- correctness
- timing
- creep risk
- perceived human-ness

---

## 25. Rollout Plan

## 25.1 Phase 0: Internal dry run

- implement event instrumentation first
- validate first 5-message logic across all entry states
- validate state transitions
- validate reminder delivery timing
- validate spam hold logic

## 25.2 Phase 1: Limited beta

- start with a small referred user cohort
- monitor every first-day transcript manually
- keep experimentation narrow
- prioritise fixing clarity and timing bugs over adding capabilities

## 25.3 Phase 2: Broader beta

- enable experiments on opening phrasing and check-in logic
- track activation by entry state
- tighten memory scoring based on correction rate

## 25.4 Phase 3: Distribution readiness

Only scale acquisition when:

- time to first value median is below target
- reminder delivery reliability is strong
- proactive ignore rate is controlled
- composite activation is healthy
- memory correction rate is low

---

## 26. What Nest Must Not Do in the First 48 Hours

These are explicit product constraints.

1. Do not ask for email
2. Do not ask the user to download an app
3. Do not ask the user to set up a profile
4. Do not request calendar or contacts access
5. Do not explain the AI stack
6. Do not overuse the user's name
7. Do not send two unreplied proactive messages inside 72 hours
8. Do not force memory references just to look clever
9. Do not default to reminders when the user is actually asking for drafting or emotional organisation
10. Do not treat all users as if they came in through the same motivation

---

## 27. Product and Engineering Requirements Summary

## 27.1 Product requirements

- conversational onboarding, not form onboarding
- multi-wedge first-value system
- behaviour-gated proactive logic
- conservative useful memory system
- explicit trust microcopy support
- composite activation model

## 27.2 Engineering requirements

- entry-state classifier
- first-value wedge selector
- first 5-message policy guardrails
- behavioural state machine
- reminder scheduling and delivery system
- proactive orchestration engine
- memory candidate generation and scoring
- spam-hold enforcement
- event instrumentation
- experiment framework
- transcript review tooling or exports

## 27.3 Data requirements

- event warehouse table for onboarding events
- conversation-state table for first-48-hours state
- reminder table with creation and delivery tracking
- memory candidate table with scoring
- experiment assignment logging

---

## 28. Cursor Build Checklist

Use this as the implementation checklist.

### Core conversation system
- [ ] Build onboarding entry-state classifier
- [ ] Build first-value wedge selection logic
- [ ] Build first 5-message guardrail layer
- [ ] Build name capture as optional, non-blocking field
- [ ] Build trust hesitation detection
- [ ] Build rescue prompt logic for stuck users

### Behaviour and orchestration
- [ ] Build first-48-hours behavioural state machine
- [ ] Build proactive eligibility engine
- [ ] Build spam-hold enforcement
- [ ] Build check-in permission gating logic
- [ ] Build memory-moment eligibility logic

### Reminder and follow-through
- [ ] Build reminder creation pipeline
- [ ] Build reliable reminder delivery pipeline
- [ ] Build reminder acknowledgement handling
- [ ] Build error correction path for wrong dates/times

### Memory system
- [ ] Build memory candidate extraction
- [ ] Build memory scoring model
- [ ] Build safe memory surfacing rules
- [ ] Build correction handling for false memory

### Instrumentation and analytics
- [ ] Emit all onboarding events
- [ ] Store experiment variants on events
- [ ] Build dashboard queries for activation funnel
- [ ] Build weekly transcript review exports

### Testing
- [ ] Write synthetic conversation test suite
- [ ] Write edge-case ambiguity suite
- [ ] Write proactive boundary suite
- [ ] Write memory safety suite
- [ ] Write regression suite for top onboarding paths

---

## 29. Suggested Pseudocode for Onboarding Controller

```ts
function handleNewUserInbound(message, userState, context) {
  const entryState = classifyEntryState(message, context)
  const trustRisk = detectTrustHesitation(message)
  const emotionalLoad = detectEmotionalLoad(message)

  if (needsClarificationImmediately(message, entryState)) {
    return askFocusedClarification(message, entryState)
  }

  if (isDirectTask(entryState)) {
    return routeToImmediateTaskHandling(message, context)
  }

  if (isDrafting(entryState)) {
    return routeToDrafting(message, context)
  }

  if (isOverwhelm(entryState) || emotionalLoad.high) {
    return routeToOrganiseFlow(message, context)
  }

  if (isTrustOpener(entryState) || trustRisk) {
    return respondWithLightTrustReassurance(message, context)
  }

  return routeToCuriousOpenerFlow(message, context)
}
```

```ts
function evaluateProactiveAction(user) {
  if (hasIgnoredProactiveInLast72Hours(user)) {
    return HOLD
  }

  if (hasScheduledReminderDueNow(user)) {
    return DELIVER_REMINDER
  }

  if (needsRecoveryNudge(user)) {
    return SEND_RECOVERY_NUDGE
  }

  if (eligibleForCheckinPermission(user)) {
    return OFFER_CHECKIN_PERMISSION
  }

  if (eligibleForMorningCheckin(user)) {
    return SEND_MORNING_CHECKIN
  }

  if (eligibleForMemoryMoment(user)) {
    return SEND_MEMORY_MOMENT
  }

  return WAIT
}
```

---

## 30. Final Product Standard

A world-class onboarding experience for Nest should feel like this:

- effortless to start
- useful within one minute
- emotionally appropriate
- flexible enough to meet different user intents
- reliable in follow-through
- disciplined in proactive behaviour
- thoughtful in what it remembers and when

The user should not feel like she completed onboarding.

She should feel like she texted something, got help quickly, and now has someone useful in her pocket.

That is the standard.

