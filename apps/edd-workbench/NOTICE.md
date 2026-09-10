# NOTICE

Collate (EDD Workbench)
Copyright © 2026 XBundle Ltd. All rights reserved.

This notice covers original code written for Collate together with the
third-party open-source software it incorporates. It does not cover the
Assemble product or the proof-of-concept prototype, which live elsewhere in
this monorepo and are outside Collate's own scope.

## Third-party software

Collate incorporates the following open-source libraries. Each remains the
property of its respective copyright holders and is used under the terms of
its own license, reproduced or linked below.

### Bundled into the browser client

| Library | License |
| --- | --- |
| react, react-dom | MIT |
| @auth0/auth0-react | MIT |
| dompurify | MPL-2.0 OR Apache-2.0 |
| @aiden0z/pptx-renderer | Apache-2.0 |
| @fontsource/inter | SIL Open Font License 1.1 |
| @fontsource/ibm-plex-mono | SIL Open Font License 1.1 |

### Server, worker, and OCR service

| Library | License |
| --- | --- |
| express | MIT |
| express-oauth2-jwt-bearer | MIT |
| cors | MIT |
| pg | MIT |
| dotenv | BSD-2-Clause |
| @aws-sdk/client-s3 | Apache-2.0 |
| @aws-sdk/client-sqs | Apache-2.0 |
| @aws-sdk/lib-storage | Apache-2.0 |
| @aws-sdk/s3-request-presigner | Apache-2.0 |
| archiver | MIT |
| csv-stringify | MIT |
| fast-xml-parser | MIT |
| html-to-text | MIT |
| iconv-lite | MIT |
| mailparser | MIT |
| mbox-reader | MIT |
| officeparser | MIT |
| pst-extractor | MIT |
| word-extractor | MIT |
| 7zip-min | MIT |
| mammoth | BSD-2-Clause |
| @e965/xlsx | Apache-2.0 |
| @kenjiuno/msgreader | Apache-2.0 |
| pdfjs-dist | Apache-2.0 |
| jszip | MIT OR GPL-3.0-or-later (used here under MIT) |

### System tools (OCR service container image)

| Tool | License |
| --- | --- |
| Tesseract OCR | Apache-2.0 |
| Poppler (poppler-utils) | GPL (v2/v3, per component) — invoked as an external command-line tool, not linked into Collate's own code |

---

MIT, BSD-2-Clause, and Apache-2.0 license texts are available from each
package's own repository (linked from its npm registry page) and are not
reproduced in full here. The SIL Open Font License 1.1 text accompanies the
@fontsource font packages themselves.
