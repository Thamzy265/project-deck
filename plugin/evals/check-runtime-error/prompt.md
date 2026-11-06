---
description: /check reports a planted runtime error with file and line, and asks before editing (D3).
expected_outcome: Reports 1 runtime error at lib/main.dart:42, proposes a fix and asks before changing code.
max_turns: 25
allowed_tools: [Skill, Read, Grep, Glob]
---

/flutterdeck:check I changed the order list
