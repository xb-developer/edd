These `.msg` fixture files (`sent.msg`, `test1.msg`, `attachmentsOrder.msg`) are copied from the [msgreader](https://github.com/HiraokaHyperTools/msgreader) project's own test suite (`test/` directory), used here under its Apache License 2.0. They're real, genuine Outlook message files the library's own authors use to validate correct parsing — not synthetic/hand-built data — which is exactly why they're used here as an independent source of truth for `msg.test.ts`'s expected values, cross-checked against that project's own `test1.json`/`sent.json`/`attachmentsOrder.json` expected-output fixtures rather than derived by hand.

Copyright the msgreader project contributors. Licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).

`legacy01.doc` (renamed from `test01.doc`) is copied from the [node-word-extractor](https://github.com/morungos/node-word-extractor) project's own test suite (`__tests__/data/`), used here under its MIT License — same fixture and same rationale as `packages/edd-workbench-core/src/extractors/__fixtures__/legacy01.doc`, duplicated here because `ingest.test.ts` exercises the full worker handler path independently of that package's own extractor-level test.

Copyright the node-word-extractor project contributors (Stuart Watt). Licensed under the MIT License.
