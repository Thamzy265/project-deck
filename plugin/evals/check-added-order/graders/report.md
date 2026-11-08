---
type: llm
---

PASS if the reply is a short report with the lines Reload, Runtime errors, Logs, Database and Next, says the reload succeeded and there are no runtime errors, and says the orders table has 1 row added.
FAIL if any of these lines is missing, if it says a row was changed or removed, or if it shows the added row's values (such as "Juice") instead of a count.
