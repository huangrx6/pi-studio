# Skill Hub

Pi Studio exposes two skill source adapters: a local directory and a static
registry JSON document. Both use the same discovery, quarantine preview,
integrity verification, atomic install, and update flow.

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
