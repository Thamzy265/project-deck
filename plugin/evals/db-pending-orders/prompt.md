---
description: /db answers a count with db_query and changes nothing (M4 acceptance, first half).
expected_outcome: Says 3 orders are pending and shows the SELECT count(*) it ran on the app database.
max_turns: 15
allowed_tools: [Skill]
---

/flutterdeck:db how many orders are pending?
