---
description: /check after the user added an order reloads, reads errors and logs, and reports 1 row added (M4 acceptance, second half).
expected_outcome: Reload ok, no runtime errors, no warnings, orders +1, all clear.
max_turns: 25
allowed_tools: [Skill]
---

/pitdeck:check I added an order in the app
