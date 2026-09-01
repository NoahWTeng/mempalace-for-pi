---
description: Declare this project's MemPalace memory in .pi/mempalace.json
argument-hint: "[palace-path]"
---
Set up MemPalace memory for the project in the current working directory.

1. Read `.pi/mempalace.json` first. If it already declares a palace, report what it
   declares and stop. Never overwrite an existing declaration: it points at memory
   the user has already written, and a replacement silently strands it.

2. Otherwise create `.pi/` and write `.pi/mempalace.json` with exactly two keys,
   `version` and `palace`:

   ```json
   {
     "version": 1,
     "palace": "PALACE"
   }
   ```

   Resolve `PALACE` to `${1:-~/.mempalace/palace-<project-directory-name>}`. When
   no argument is given that default stands in for the current working directory's
   name, which you substitute — a palace path that still contains
   `<project-directory-name>` is a bug, not a default. Keep the leading `~/`
   instead of expanding it: the declaration is committed with the project, and the
   `~/` form is what lets another machine read the same document without
   re-exporting anything.

3. `version` must be exactly `1`. The only other accepted keys are `palace`,
   `readOnly`, `handoff`, `disabled`, and `recall`. An unknown key makes MemPalace
   refuse the whole document rather than ignore the key.

4. Then tell the user, in this order, what remains outside your control:
   - commit `.pi/mempalace.json` with the project;
   - trust the project folder if Pi has not already asked, because an untrusted
     project reads no `.pi/mempalace.json` at all;
   - restart Pi, because the document is read only at session start.

5. After that restart — not before — `palace_status` reports whether the palace is
   operational.
