# Finding: can Siri AI carry a briefing?

The gate of docs/superpowers/specs/2026-11-10-ios-secretary-design.md, "Order of work" step 1. **Question:** while a briefing is active, does Siri AI route a bare follow-up ("approve", "next", "stop", "later") to `BriefingReplyIntent`?
- with the app in the foreground;
- in the background with a Live Activity showing;
- when the conversation continues in the Siri app after "Brief me in Brief spike".

**And:** how does a turn end and resume?

This file is filled in by hand on the device. When it is, its result paragraph and matrix go into the design, and `ios/Spike` is deleted (see "After the runs").

## The build under test

| | |
| --- | --- |
| iPhone model | |
| iOS build (Settings → General → About → iOS Version, then tap it for the build) | |
| Siri AI Developer Preview version (as the release notes or Settings name it) | |
| Xcode version and build | |
| Language and region of Siri | |
| Date of the runs | |

## What Apple's documentation already says (read Nov 12, 2026)

From the Siri AI Developer Preview pages (developer.apple.com/documentation/appintents/siri-ai-developer-preview, "Bringing custom actions and content to Siri", `ToolIntent`, "Orchestrating complex actions with app skills", Siri Evaluations):

1. **The three surfaces are named, for requests in general.**
   - Apple's wording: "People don't have to mention your app in their request while your app is in the foreground, while a Live Activity is active, or when a person continues a conversation in the Siri app that includes a mention of your app."
   - In the background, requests must name the app.
   - Every example is a full sentence ("change my ride pickup to <a new address>"). Nothing says whether a one-word reply ("approve") counts as a request Siri routes to the app. That is what the matrix measures.
2. **`ToolIntent`'s own page lists different conditions.** It says Siri can call a tool when:
   - a person mentions the app by its name;
   - the app is in the foreground;
   - a relevant entity from the app appears in a search result.

   It does not list a Live Activity. The Live Activity column is the one most likely to differ from the overview.
3. **Apple advises against tools for consequential actions.** `ToolIntent` lists "intents with side effects that a person needs to start explicitly, such as placing an order and paying for it" among intents that don't make good tools. An approve that sends a reply may count as one. If Siri asks to confirm before calling `BriefingReplyIntent`, this is likely why. Siri Evaluations counts a confirmation question as a call that did not run, so the report shows it.
4. **App skills don't sequence anything.**
   - Apple's wording: "You can't use app skills to enforce deterministic behavior," and "Siri AI doesn't sequentially perform the tool intents that your skill lists."
   - A skill can guide "a conversation flow for a series of tool intents".
   - The spike ships one skill, `briefing-reply`. The order of the briefing stays the app's machine's, as the design already says.
5. **Multi-turn is a first-class idea in the test harness.** A `SiriScenario` is "an ordered, multiturn interaction run in one Siri session". Nothing in the documentation describes:
   - how long a session stays open;
   - what ends it (silence, locking, another app);
   - whether an app's dialog keeps it open for the next utterance.
6. **There's no API for continuing a conversation.** The documentation names none for the Siri app continuation or the Live Activity: both are conditions Siri checks, not something an app adopts. The spike provides the conditions:
   - a Live Activity while the briefing runs;
   - App Shortcut phrases that name the app ("Brief me in Brief spike");
   - the app in the foreground.

   It also tries the two mechanisms the documentation does offer:
   - tool intents (`@AppIntent(.tool)`) plus an app skill;
   - a parameter value requested inside one intent (`requestValue`, `GuidedBriefingIntent`).
7. **Authentication is per intent.**
   - `IntentAuthenticationPolicy.requiresAuthentication` and `.requiresLocalDeviceAuthentication` exist.
   - A property-level policy applies only to what Siri says. An intent that returns sensitive information sets the policy on the intent.
   - `ApproveWithUnlockIntent` uses `.requiresAuthentication`.
8. **Where it runs.** The preview works only:
   - in a development-signed build on a device with Apple Intelligence, in a region where Siri AI is available (not the EU);
   - for internal TestFlight testers.

   It isn't available to external testers or in App Store builds.
9. **The test harness needs:**
   - a UI testing target signed by the same team as the app;
   - Developer Mode;
   - Settings → Developer → Enable UI Automation.

   Apple adds: "Because Siri's responses can vary between runs, run the set more than once."

## Install

Needs the Xcode beta with the iOS 27.3 SDK, and an iPhone 15 Pro or later on the iOS 27.3 beta with Apple Intelligence and Siri AI on, in English, outside the EU.

1. `cd ios/App`, then `echo 'DEVELOPMENT_TEAM = <your team id>' > Signing.local.xcconfig` (not committed).
2. `xcodegen generate`, then open `PBCP.xcodeproj` **in the Xcode beta**.
3. Choose the scheme **Spike** and your iPhone, then **Run**. On the phone: Settings → Privacy & Security → Developer Mode on, and trust the developer certificate if asked.
4. Open **Brief spike** once, so it indexes its three items into Spotlight and registers its App Shortcuts.
5. For the scripted runs: on the phone, Settings → Developer → Enable UI Automation. In Xcode: **Product → Test** (scheme Spike). Xcode's report shows, for each turn:
   - which intent Siri called, with which arguments;
   - what Siri said.

   Run it at least twice.

The preview parts (`@AppIntent(.tool)`, the evaluations, the skills bundle's validation) compile only with the iOS 27.3 SDK. They have never been built before your first build. If the Xcode beta reports an error in `Spike/App/Intents.swift`, `Spike/App/Entities.swift` or `Spike/Evaluations/`, the preview's API differs from its documentation of Nov 12. Fix it to what the beta says, and note it below.

## What to say, in order

Before each surface, pick the surface on the spike's screen, so the log records where you were. After each surface, tap **Share log** and paste the log under "Logs".

**A. Foreground.** Brief spike open on screen. Tap **Start briefing here**, then hold the side button for each line:
1. "approve"
2. "next"
3. "what's the weather"
4. "later"
5. "approve the reply to Anna" (after "Start briefing here" again, if the briefing has closed)
6. "the second one is done"
7. "stop"

**B. Background with the Live Activity.** Open the spike, tap **Start briefing here**, check that the Live Activity shows "Decision 1 of 3", then go to the Home Screen. Say the same seven lines.

**C. The Siri app.** Swipe Brief spike away from the app switcher. Say "Brief me in Brief spike", then the same seven lines, without naming the app again.

**D. Step by step** (the `requestValue` candidate). Any surface: say "Brief me step by step in Brief spike", then "approve", "done", "next".

## The matrix

**Reached `BriefingReplyIntent`?** Answer one of:
- **yes**;
- **Siri itself** (Siri answered without the app);
- **which app?** (Siri asked);
- **confirm?** (Siri asked to confirm first);
- **nothing**.

**Turn** means whether Siri kept listening for the next utterance (**open**) or the turn ended (**ended**). Latency is by feel: instant, a beat, or slow.

### A. Foreground

| Utterance | Reached the reply intent? | Siri's spoken response | Latency | Turn |
| --- | --- | --- | --- | --- |
| approve | | | | |
| next | | | | |
| what's the weather | | | | |
| later | | | | |
| approve the reply to Anna | | | | |
| the second one is done | | | | |
| stop | | | | |

### B. Background, Live Activity showing

| Utterance | Reached the reply intent? | Siri's spoken response | Latency | Turn |
| --- | --- | --- | --- | --- |
| approve | | | | |
| next | | | | |
| what's the weather | | | | |
| later | | | | |
| approve the reply to Anna | | | | |
| the second one is done | | | | |
| stop | | | | |

### C. Siri app, after "Brief me in Brief spike"

| Utterance | Reached the reply intent? | Siri's spoken response | Latency | Turn |
| --- | --- | --- | --- | --- |
| Brief me in Brief spike | (BriefMeIntent?) | | | |
| approve | | | | |
| next | | | | |
| what's the weather | | | | |
| later | | | | |
| approve the reply to Anna | | | | |
| the second one is done | | | | |
| stop | | | | |

### D. Step by step (`requestValue`)

| Utterance | Taken as the requested value? | Siri's spoken response | Latency | Turn |
| --- | --- | --- | --- | --- |
| Brief me step by step in Brief spike | | | | |
| approve | | | | |
| done | | | | |
| next | | | | |

### Ending and resuming a turn

| Check | What happened |
| --- | --- |
| 30 s of silence mid-briefing, then "next" (no wake word, then with it) | |
| Lock the phone mid-briefing, then "next" | |
| A phone call mid-briefing, then "next" after it | |
| "Brief me in Brief spike" after a stop: does it pick up at the item it stopped on? | |
| The Live Activity's buttons (Approve, Done, Next, Stop): do they answer and update it? | |
| Phone locked, "Approve with unlock in Brief spike" (`ApproveWithUnlockIntent`, `.requiresAuthentication`): how does Siri ask for the unlock, and does it go on afterwards? | |
| Phone locked, a plain "approve" during a briefing: does it run without unlocking? | |

### The scripted runs (Siri Evaluations)

| Run | Foreground: intents all pass | Background: intents all pass | Siri app: intents all pass | Notes from the report |
| --- | --- | --- | --- | --- |
| 1 | | | | |
| 2 | | | | |

## The continuation affordance

What it turned out to be on the device. For example:
- the Siri app keeps the conversation open after the app's dialog;
- the Live Activity is what lets a bare word reach the app;
- `requestValue` is the only thing that keeps a turn open.

(to fill in)

## Result

One paragraph: **yes** or **no**, with the evidence from the matrix. Yes means the gate passes and the native app goes ahead. No means the briefing machine ships as the web app's talk mode.

(to fill in)

## Logs

(paste each surface's shared log here)

## After the runs

When this file is filled in:
1. Its result paragraph and its matrix go into the design on `ios-secretary-design`, under "Order of work" step 1, as "Result". The gate is marked passed or failed there.
2. `docs/briefing-machine.md` changes only where the spike contradicted it.
3. A final commit on this branch deletes `ios/Spike`, its targets and scheme in `ios/App/project.yml`, `ios/App/Signing.xcconfig` and its `.gitignore` line, and the line in `ios/README.md`.
