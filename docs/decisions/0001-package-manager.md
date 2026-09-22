# ADR 0001: pnpm workspace

Status: accepted on 2026-09-21.

Use pnpm 10.15.0 through Corepack with a committed frozen lockfile. It provides explicit workspace dependency edges, efficient local linking, reproducible installs, and a clear separation between internal source packages and anything intentionally published. npm and yarn remain possible future migrations, but changing the package manager requires a deliberate lockfile and CI transition.
