---
type: regex
# "3 … pending" or "pending … 3" in one clause (no comma, period, semicolon, bracket, other number or line break between), and no "none", "no" or "not" in it.
pattern: '(^|[^\d])3\b(?:(?!\b(?:none|no|not)\b)[^\n.,;()\d]){0,40}\bpending|\bpending(?:(?!\b(?:none|no|not)\b)[^\n.,;()\d]){0,40}(^|[^\d])3\b'
flags: i
---
