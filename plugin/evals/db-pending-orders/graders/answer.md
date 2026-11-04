---
type: regex
# "3 … pending" or "pending … 3" in one clause (no comma, period or line break between), and no "none", "no" or "not" in it.
pattern: '(^|[^\d])3\b(?:(?!\b(?:none|no|not)\b)[^\n.,]){0,40}\bpending|\bpending(?:(?!\b(?:none|no|not)\b)[^\n.,]){0,40}(^|[^\d])3\b'
flags: i
---
