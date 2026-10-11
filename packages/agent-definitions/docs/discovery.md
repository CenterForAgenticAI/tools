# Definition discovery

Agent Definitions 0.1 uses the same discovery order as pi-delegate. Definition folders are searched from lowest to highest precedence:

1. each folder in `packageDirs`, in the order supplied;
2. `~/.pi/agent/agents`, then `~/.agents`, unless the caller supplies `userDirs`;
3. the project folders `.agents`, `.agents/agents`, then `.pi/agents`.

A caller can supply extra folders through `packageDirs` and `userDirs`. A supplied list replaces that origin's default list and is ordered from lowest to highest precedence.

## Project root

Discovery starts at `cwd` and walks towards the filesystem root. The first directory that contains either a `.pi/agents` directory or a `.agents` directory is the project root. The walk stops before checking the home directory, so a home-level `.agents` folder is user configuration, not a project marker. If the walk reaches home or the filesystem root without finding a marker, project folders are not searched.

Each folder contributes only visible `*.md` files directly inside it. Discovery does not recurse. It skips dotfiles and `*.chain.md` files. Missing folders are ignored. A folder that cannot be read is skipped and produces a `discovery-unreadable` warning when definitions are loaded.

## Shadowing

Package definitions have the lowest origin precedence, followed by user definitions and then project definitions. Within one origin, a later folder wins. Files that resolve to the same real path are loaded once from the higher-precedence location.

When definitions share a `name`, `loadDefinitions` keeps the higher-precedence definition and reports every loser with a `definition-shadowed` hint. The result also lists each losing file and the file that shadows it.

Other tools' folders, such as `.claude/agents`, are not searched in 0.1. Callers that need those folders can include them explicitly in `userDirs` or `packageDirs`.
