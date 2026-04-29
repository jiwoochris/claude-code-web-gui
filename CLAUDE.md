# Project conventions

## Definition of done

A task is **not** complete until it is deployed. The default workflow is:

1. Implement the change.
2. Verify locally where possible.
3. Commit and push.
4. Run the deploy (`./deploy.sh` or the equivalent for the target host) and confirm it lands in production.

If any of these steps are skipped, say so explicitly and treat the task as in-progress, not done.
