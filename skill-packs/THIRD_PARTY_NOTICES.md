# Third-party notices: bundled skill packs

Agent Office bundles the following Claude Code skill packs, each copied unmodified from one upstream commit except where a patch or dropped path is listed (see `manifest.json` and each pack's `UPSTREAM.json`). Each pack folder carries the upstream licence and notice files; those files govern the pack's contents, not Agent Office's MIT licence.

## karpathy (andrej-karpathy-skills)
- Source: https://github.com/multica-ai/andrej-karpathy-skills at `2c606141936f1eeef17fa3043a72095b4765b9c2`
- Licence: MIT; files: `NOTICE`
- Skills (1): karpathy-guidelines
- Upstream has no LICENSE file; it declares MIT in README.md and plugin.json. `NOTICE` records this and carries the MIT text.

## ui-ux-pro-max (ui-ux-pro-max)
- Source: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill at `d14efff8ed1faa4187f004f79926f428c8074ec7`
- Licence: MIT (ui-styling: Apache-2.0; fonts: SIL OFL 1.1); files: `LICENSE` (plus per-skill `LICENSE.txt` and font `*-OFL.txt` files)
- Skills (7): banner-design, brand, design, design-system, slides, ui-styling, ui-ux-pro-max

## superpowers (superpowers)
- Source: https://github.com/obra/superpowers at `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b`
- Licence: MIT; files: `LICENSE`
- Skills (14): brainstorming, diagnosing-superpowers, dispatching-parallel-agents, executing-plans, finishing-a-development-branch, receiving-code-review, requesting-code-review, subagent-driven-development, systematic-debugging, test-driven-development, using-git-worktrees, verification-before-completion, writing-plans, writing-skills
- Not shipped: `hooks/` and the `using-superpowers` bootstrap skill; modified (manifest patch): `brainstorming/SKILL.md` description

## skill-creator (skill-creator)
- Source: https://github.com/anthropics/claude-plugins-official at `58267944f92187b7d6a1c822165c96c81c864806`
- Licence: Apache-2.0; files: `LICENSE` (plus per-skill `LICENSE.txt` and font `*-OFL.txt` files)
- Skills (1): skill-creator

## design-dna (design-dna)
- Source: https://github.com/zanwei/design-dna at `593e39bc9e3652734653bd75544a333d7d43615e`
- Licence: MIT; files: `LICENSE`
- Skills (1): design-dna
- Patched: `skills/design-dna/SKILL.md`: no silent runtime npm install: ask the user before installing sharp

## anthropic-skills (example-skills)
- Source: https://github.com/anthropics/skills at `dbd4588f9e1033efb41dad4bef2f7947c8993d44`
- Licence: Apache-2.0 (fonts: SIL OFL 1.1); files: `LICENSE.txt`, `THIRD_PARTY_NOTICES.md` (plus per-skill `LICENSE.txt` and font `*-OFL.txt` files)
- Skills (11): algorithmic-art, brand-guidelines, canvas-design, claude-api, frontend-design, internal-comms, mcp-builder, slack-gif-creator, theme-factory, web-artifacts-builder, webapp-testing

## caveman (caveman)
- Source: https://github.com/JuliusBrussee/caveman at `1f951fb4ad40ba63302c6e7f987147e034d599d9`
- Licence: Apache-2.0 (parts MIT); files: `LICENSE`, `LICENSE-MIT`, `NOTICE`
- Skills (4): caveman, caveman-commit, caveman-help, caveman-review

## taste-skill (taste-skill)
- Source: https://github.com/Leonxlnx/taste-skill at `6010f91a9935f1c167dfc500fb1a475681892e6b`
- Licence: MIT; files: `LICENSE`
- Skills (1): taste-skill

## scroll-craft (nateherk-design)
- Source: https://github.com/nateherkai/scroll-craft at `75d81f74e83692add18cd7a8a8e078b8a887a579`
- Licence: MIT; files: `LICENSE`
- Skills (1): scroll-craft
