# New task: hero animation — "cordless CLI → mobile app takeover"

Context you already know: the cordless landing page is `docs/index.html`, editorial-dark + CLI
theme (Alumni Sans display, JetBrains Mono, Albert Sans body; colors: green `#9ece6a`, blue
`#7aa2f7`, purple `#bb9af7`, amber `#e0af68`; agent colors: Claude `#d97757` ✳, Codex `#10a37f` ❋,
GitHub Copilot `#2f81f7` ◉, shell `#6b7280` `>_`).

Current hero = 2-col grid:
- LEFT: kicker "remote terminals, in your pocket", H1 "Your dev box. / Every session. / On your
  phone.", lead paragraph, `$ npx cordless-cli` runline, and a row of agent badges.
- RIGHT: a terminal window `.term` that does a scroll-triggered staged reveal (JS adds `.go`):
  `cordless pair` → faux QR → `✓ paired "iPhone 15"` → `cordless` → 4 session rows
  (claude=working, codex=waiting·you, copilot=idle, shell=idle) with a blinking cursor.

The user's new request, verbatim: **"full animation of Cordless CLI with Mobile app take over"** —
they want the hero to *show the story*: the CLI running on the dev box, then the **mobile app taking
over** those same sessions. The product metaphor is "browser tabs for remote terminal sessions,
driven from your phone" (default tab is `>_<`; tabs for Claude/Codex/Copilot).

I already verified `npm i -g cordless-cli` / `npx cordless-cli` works on Linux/macOS/Windows (npm
smoke test green), so the install command stays.

Please give me a concrete, tasteful **storyboard** for this hero animation — classy and editorial,
NOT a gimmicky toy. Answer these specifically:

1. **Composition**: keep the terminal on the right and slide a **phone** in next to/overlapping it?
   Or morph the terminal → phone? Or terminal on the left of the visual, phone on the right, with a
   "handoff" between them? What reads clearest at a glance on desktop AND stacks well on mobile?
2. **Beat-by-beat timeline** (seconds): what happens in each beat, from CLI boot → pairing → the
   phone "taking over" the sessions as tabs → a live session on the phone. Give exact beats + rough
   durations.
3. **The "takeover" moment**: how do I make the handoff *feel* like the phone taking control — a
   beam/pulse from the QR to the phone? session rows flying from terminal into phone tabs? a synced
   highlight? Keep it 1 strong idea, not 5.
4. **Loop or play-once?** If loop, how long a cycle and how to make the loop seamless and not
   annoying on a landing page?
5. **Performance + a11y**: it must be pure CSS transforms/opacity (no layout thrash), and fully
   respect `prefers-reduced-motion` (show the end state, no motion). Any traps to avoid?

Give me the storyboard as tight beats I can implement directly in HTML/CSS/JS. Be opinionated.
