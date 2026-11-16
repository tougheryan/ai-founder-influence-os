# Echo Founder integration notes

This directory contains the source snapshot used by Echo Founder for local
HTML-to-image rendering. Its declared license remains AGPL-3.0-only, with the
full upstream text retained in LICENSE. It is not relicensed under the root MIT
license and no upstream endorsement is implied.

Echo Founder keeps the command-line screenshot and validation interfaces and
uses its own production orchestration outside this directory. The public source edition restores the magazine background and editorial/Swiss
compatibility assets from the existing Echo Founder source revision because the
active renderer still references them; the developer working-tree deletions are
not changed. All source files included in this snapshot
are available in this repository; runtime npm dependencies are installed from
the adjacent package-lock.json under their individual licenses.

Integration snapshot prepared on 2026-11-16. Future distributed applications
must retain this directory's source, license, original README notices, and the
exact dependency/license inventory required by the desktop packager.

License and source availability boundaries:

- The declared SPDX identifier is `AGPL-3.0-only`; the original text in `LICENSE` is authoritative.
- The complete customer source snapshot is included in this directory, including this MODIFICATIONS.md and the original LICENSE, README.md, and README.en.md.
- A distributed desktop package must preserve the same complete customer source snapshot and dependency notices. This note does not certify a commercial deployment, network service, or broader distribution.
- Commercial or other redistribution requires independent license-compliance review. This document is not legal advice or legal approval.
