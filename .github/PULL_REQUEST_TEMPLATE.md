## What does this PR do?

<!-- Brief description of the change and why it's needed. -->

## Related issue

<!-- Use "Closes #N" / "Fixes #N" so GitHub auto-closes it on merge. -->
<!-- A bare "#N" reference does NOT auto-close the issue. -->

Closes #

## Checklist

- [ ] `make check` passes (tsc --noEmit, renderer + main)
- [ ] `make test` passes (vitest unit/integration)
- [ ] If this touches Electron packaging, IPC, or anything that behaves
      differently once compiled, I verified it against the real packaged
      app (`make dist-linux && make run-linux`), not just `npm run dev`
- [ ] Unrelated changes are kept out of this PR
