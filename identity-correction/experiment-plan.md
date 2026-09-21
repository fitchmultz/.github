# Bounded identity correction experiment

Initial diagnostic worktree clean at local/remote dd49f13bc777b98291f80cd1c446db9940da1dfc. Frozen236 baseline is copied privately; no shared Browser edits.

1. One fresh native Windows job: original complete five-file prefix, existing callback observation restricted to process-identity.ts, plus native Console.Error phase timestamps before Get-Process, after Get-Process/before StartTime, and after original output expression. No lock instrumentation, primer, timeout/cache/normalization change. Phase observations cannot identify pre-script startup internals or module subphases.
2. Only if phase evidence supports bypassing command dispatch: one fresh job using direct System.Diagnostics.Process.GetProcessById with terminating errors and the same output expression; phase observation for comparison. Not a hot A/B. No retry-until-green.
3. If supported: one fresh uninstrumented candidate job with original five-file prefix first, followed by native identity compatibility and existing policy/process/close/cross-instance checks. LF failure remains independently owned. Qualify local independent official/fork graphs serially for UID-global close fixture, plus Node22 floor.

All jobs retain35min/900s command/600s install budgets and original individual deadlines/concurrency/assertions. Results are bounded samples, not latency guarantees. If native script entry consumes the failed deadline, do not adopt a dispatch replacement as a startup fix. Parent owns combined qualification, reviews and delivery.
