# Skill Hub

Pi Studio exposes three skill source adapters: a local directory, a GitHub
repository, and a static registry JSON document. All of them share the same
discovery, quarantine preview, integrity verification, atomic install, and
update flow.

## Source layout

A directory source is scanned recursively. Every directory that directly
contains `SKILL.md` is one Agent Skill root. The scanner does not descend into
that root as a source collection.

## Registry schema

The registry schema is
[`pi-studio.skill.registry.schema.json`](../schemas/pi-studio.skill.registry.schema.json).
An entry points to a ZIP package and publishes its SHA-256 digest. The package
must contain exactly one `SKILL.md`. It may place that file at the ZIP root or
inside one wrapper directory.

```json
{
  "schemaVersion": 1,
  "name": "Team Skills",
  "skills": [
    {
      "name": "review-checklist",
      "description": "Review a change with a repeatable checklist.",
      "version": "1.2.0",
      "invocation": "automatic",
      "download": "https://skills.example.com/review-checklist-1.2.0.zip",
      "sha256": "<64 lowercase hex characters>"
    }
  ]
}
```

`download` accepts HTTPS or a path relative to the registry JSON. HTTP is only
accepted for loopback development. The declared digest is mandatory and is
checked before the ZIP is extracted.

### Link catalogs

A registry without `schemaVersion`, or with `schemaVersion: 2`, is a *link
catalog*: every entry publishes only a name, a description, and a URL. This is
the shape most third-party indexes export. Its schema is
[`pi-studio.skill.registry.v2.schema.json`](../schemas/pi-studio.skill.registry.v2.schema.json).

```json
{
  "skills": [
    {
      "name": "review-checklist",
      "description": "Review a change with a repeatable checklist.",
      "url": "https://github.com/example/skills/tree/main/skills/review-checklist/SKILL.md"
    }
  ]
}
```

Link catalogs trade integrity for reach: there is no digest to verify, so the
installed content is hashed at install time and any later edit shows up as a
content change. Entries are validated one by one — a bad or duplicate name
becomes a diagnostic on the source instead of failing the whole catalog — which
matters for the multi-thousand-entry indexes these sites publish.

For a GitHub link, Studio reads `SKILL.md` from `raw.githubusercontent.com` and
then tries to pull the sibling files of the same directory through the GitHub
contents API, so `references/` and `scripts/` arrive with the skill. When that
listing is unavailable (rate limit, private repository), the install falls back
to the single `SKILL.md` and the preview lists exactly what was fetched. A link
that returns 404 reports `链接可能已失效` instead of a network stack trace.

## System proxy and VPN

Remote sources and GitHub archives are fetched through Electron's `net.fetch`,
which uses Chromium's network stack and therefore honours the operating system
proxy and PAC settings. Node's own `fetch` ignores them, which is why a VPN that
only configures a system proxy used to leave GitHub downloads timing out while
the rest of the application worked.

## Discovery and installation

1. Studio reads source metadata and shows name, complete description, version,
   invocation mode, resource count, and estimated prompt cost.
2. A preview copies a directory or verified ZIP into
   `<userData>/skill-quarantine/<token>`.
3. Studio validates the Agent Skills frontmatter and the complete file graph.
4. The reviewed content is copied into a temporary sibling, its content digest
   is checked again, and the destination is switched atomically.
5. User skills become available at the next safe request boundary. Project
   skills also require a trust record before they can be loaded.

Source removal only deletes the catalog registration. Installed skills remain
until removed from their own skill scope.

## Pack a skill

The repository includes a deterministic packer:

```sh
pnpm skill pack ./my-skill --out ./dist/my-skill.zip
```

It validates `SKILL.md`, rejects symlinks and `.git`/`node_modules`, creates a
ZIP with one stable top-level directory, and prints the registry fields,
including the SHA-256 and byte size. Add `--json` for automation or
`--download <URL>` to place the final hosted URL directly into the generated
entry.
