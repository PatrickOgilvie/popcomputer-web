---
name: github-release
description: "Create the GitHub Release for a version of @popcomputer/web from its CHANGELOG.md section. Use when releasing a version, once its `chore: release <version>` commit is tagged `v<version>` and the tag is pushed, and to add a release the Releases page is missing."
---

# The GitHub Release

Every version has a GitHub Release. GitHub shows the latest one beside the
code, and people and AI read it for what changed.

Releasing is by hand. A `chore: release <version>` commit moves the
changelog's `[Unreleased]` section under the version and its date, adds
`UPGRADING.md`'s section and sets `package.json`'s version. It is tagged
`v<version>`, and the owner pushes it and publishes it to npm. The GitHub
Release is the last step, once the tag is pushed.

## Write the notes

The body is the version's section of `CHANGELOG.md` without its heading, then
how to install it. These commands give the existing releases' bodies byte for
byte:

```sh
version=1.9.0
notes="$(mktemp)"
awk -v heading="## [$version]" '
  index($0, heading) == 1 { found = 1; next }
  found && /^## \[/ { exit }
  found { print }
' CHANGELOG.md | sed '1{/^$/d;}' > "$notes"
printf '\nInstall with:\n\n```sh\nbun add @popcomputer/web@%s\n```\n' "$version" >> "$notes"
```

Read `$notes` before it goes out: it should open with the release's summary
and end with the `bun add` line.

## Create the release

A release is public, like a push, so ask the owner first.

```sh
gh release create "v$version" --verify-tag --title "@popcomputer/web $version" --notes-file "$notes" --latest
```

`--verify-tag` refuses when the tag is not on GitHub, rather than tagging
whatever `main` is, so the release names the commit that was published. For
an older version added later, pass `--latest=false` in place of `--latest`.
