#!/usr/bin/env bash
# PreToolUse (Bash): dependencies enter this repository pinned, through Bun, and without
# trusting install scripts. bunfig.toml holds the 7-day release floor and exact pins; this
# hook catches the commands that would get around them, where they are typed.
#
# Blocks: npm/pnpm/yarn installs (their own lockfile, no floor), `bun add` without --exact
# and an exact x.y.z, ranges and moving tags, --trust, `bun pm trust`, and overriding the
# release age. A bare `bun install` passes. Fails closed: without jq it cannot judge.
# Kept identical in Relic and Ranni.
set -uo pipefail
trap 'rc=$?; if [ "$rc" -ne 0 ] && [ "$rc" -ne 2 ]; then echo "Blocked: guard-install.sh crashed (exit $rc); it fails closed." >&2; exit 2; fi' EXIT
command -v jq >/dev/null 2>&1 || { echo "Blocked: guard-install.sh needs jq (brew install jq)." >&2; exit 2; }

cmd=$(jq -r '.tool_input.command // empty')
[ -n "$cmd" ] || exit 0
block() { echo "Blocked: $1" >&2; exit 2; }
set -f

# One command per line: split on ; & | ( ) and newlines; drop redirections first so `2>&1`
# is not read as a separator or a package.
cmds=$(sed -E 's/[0-9]*&?[<>]+(&[0-9-]+|[[:space:]]*[^[:space:];&|<>()]+)//g' <<<"$cmd" | tr ';&|()' '\n\n\n\n\n')

while IFS= read -r line; do
  # Leading env assignments and wrappers keep the command in command position.
  line=$(sed -E 's/^[[:space:]]*(([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|time|command|exec|env)[[:space:]]+)*//' <<<"$line")
  read -r -a w <<<"$line" || true
  [ "${#w[@]}" -gt 0 ] || continue
  case "${w[0]}" in
    npm | pnpm | yarn)
      case "${w[1]:-}" in
        install | i | add | ci | "")
          block "this repository installs with Bun only. \`${w[0]}\` writes its own lockfile and skips the exact pins and the 7-day release floor. Use \`bun install\` or \`bun add --exact <pkg>@<x.y.z>\`." ;;
      esac ;;
    bun)
      if [ "${w[1]:-}" = pm ] && [ "${w[2]:-}" = trust ]; then
        block "\`bun pm trust\` lets a dependency run install scripts. That is the developer's decision; say which package and why."
      fi
      case "${w[1]:-}" in add | a | install | i) ;; *) continue ;; esac
      exact=no
      pkgs=()
      for t in "${w[@]:2}"; do
        case "$t" in
          --exact | -E) exact=yes ;;
          --trust) block "\`--trust\` lets a dependency run install scripts. That is the developer's decision; say which package and why." ;;
          --minimum-release-age*) block "the 7-day release floor in bunfig.toml is not overridden from the command line." ;;
          -*) ;;
          *) pkgs+=("$t") ;;
        esac
      done
      [ "${#pkgs[@]}" -gt 0 ] || continue
      for p in "${pkgs[@]}"; do
        name=$(sed -E 's/(.)@[^@/]*$/\1/' <<<"$p")
        version=${p#"$name"}
        version=${version#@}
        if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
          block "\`$p\` is not an exact version. Pin it: bun add --exact $name@<x.y.z> (releases younger than 7 days do not install)."
        fi
      done
      [ "$exact" = yes ] || block "state the pin where it is installed: bun add --exact ${pkgs[0]}."
      ;;
  esac
done <<<"$cmds"
exit 0
