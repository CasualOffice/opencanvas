Test-only snapshot of the v0.1.1 board model (`git show v0.1.1:web/packages/board/src/<file>`),
unchanged: model.ts, ops.ts, connectors.ts. Used only by src/mixed-version.test.ts (DGM-18) to run
a deployed 0.1.1 client against the current code on shared Yjs documents. Not part of the package:
nothing outside tests imports it, the package tsconfig does not include this folder, and it is
not in any bundle.
