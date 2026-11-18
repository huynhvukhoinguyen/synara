// FILE: skillPromptInjection.ts
// Purpose: Inlines portable skill instructions into the outgoing prompt for providers
//          that cannot natively load the referenced skill files. This is the fallback
//          that makes Synara catalog skills usable on every provider.
//          A skill the provider already serves natively under another name (Claude's
//          skills plugin) gets a short pointer to that name instead of its body.
// Layer: Server provider helper
// Exports: shouldInlineSkillForProvider, selectSkillsToInline, selectNativelyServedSkills,
//          loadInlineSkillBlocks, formatInlineSkillInstructions, buildInlineSkillInstructions

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import type { ProviderKind, ProviderSkillReference } from "@synara/contracts";

import { pathIsWithin } from "./claudePluginSkills.ts";
import { leadingSlashTokenName } from "./promptSkillReferences.ts";
import { skillNameKey } from "./skillsCatalog.ts";

// Per-skill cap keeps a single oversized SKILL.md from eating the turn budget.
const MAX_INLINE_SKILL_CONTENT_CHARS = 24_000;

const INLINE_SKILLS_HEADER =
  "The user invoked the following agent skill(s) for this request. Their full " +
  "instructions are included below, so follow them directly; do not look them up or " +
  "load them again with a skill tool. File paths referenced inside a skill are " +
  'relative to its "dir" attribute.';

const NATIVE_SKILLS_HEADER =
  "The user invoked the following agent skill(s) for this request. They are in " +
  'your skill list: load each with the Skill tool under its "invoke" name before ' +
  'you act. If one is missing from your list, read the SKILL.md at its "path" instead.';

const CROSS_PROVIDER_SKILL_DIR_NAMES = [
  ".synara",
  ".codex",
  ".cursor",
  ".claude",
  ".agents",
] as const;

function pathSegments(path: string): Set<string> {
  return new Set(
    nodePath
      .normalize(path)
      .split(/[\\/]+/)
      .map((segment) => segment.toLowerCase()),
  );
}

export function shouldInlineSkillForProvider(
  provider: ProviderKind,
  skillPath: string,
  claudeConfigDir?: string,
): boolean {
  const segments = pathSegments(skillPath);
  switch (provider) {
    case "antigravity":
      return true;
    case "codex":
      // Codex loads .codex and .agents skills natively, plus ~/.synara/skills
      // registered via skills/extraRoots/set. Only foreign provider roots
      // need inline instructions alongside their structured skill reference.
      return [".claude", ".cursor"].some((dir) => segments.has(dir));
    case "cursor":
      // cursor-agent natively scans .cursor/.agents/.claude/.codex skill roots;
      // only Synara-owned paths need inlining.
      return segments.has(".synara");
    case "claudeAgent":
      // Claude Code loads .claude/skills folders itself, and the active account can
      // place its native skills and plugins under a custom config directory. Bundled
      // and ~/.synara/skills skills reach it through Synara's skills plugin, which
      // callers report per session via `nativelyServedSkills`; anything else
      // (including a skill Settings turned off) is inlined.
      return (
        !segments.has(".claude") &&
        (claudeConfigDir === undefined ||
          (!pathIsWithin(nodePath.join(claudeConfigDir, "skills"), skillPath) &&
            !pathIsWithin(nodePath.join(claudeConfigDir, "plugins", "cache"), skillPath)))
      );
    case "devin":
      return !(
        [".agents", ".claude", ".codeium", ".cognition", ".devin", ".windsurf"].some((dir) =>
          segments.has(dir),
        ) ||
        ((segments.has(".config") || (segments.has("appdata") && segments.has("roaming"))) &&
          (segments.has("devin") || segments.has("cognition")))
      );
    case "pi":
      // Pi loads its own skill set; anything resolved from a cross-provider
      // folder is portable and must be inlined.
      return CROSS_PROVIDER_SKILL_DIR_NAMES.some((dir) => segments.has(dir));
    default:
      // Antigravity/Grok/Droid/OpenCode have no native skill support.
      return true;
  }
}

/**
 * The `.claude` skill Claude Code loads itself for this input: its `/name` must be the
 * first token of the final prompt, after every prefix Synara adds.
 */
function claudeNativelyLoadedSkill(
  providerInput: string,
  skills: ReadonlyArray<ProviderSkillReference>,
  claudeConfigDir?: string,
): ProviderSkillReference | undefined {
  const leadingName = leadingSlashTokenName(providerInput);
  if (leadingName === null) return undefined;
  const key = skillNameKey(leadingName);
  return skills.find(
    (skill) =>
      skillNameKey(skill.name) === key &&
      !shouldInlineSkillForProvider("claudeAgent", skill.path, claudeConfigDir),
  );
}

function nativelyServedSkillName(
  skill: ProviderSkillReference,
  nativelyServedSkills: ReadonlyMap<string, string> | undefined,
): string | undefined {
  return nativelyServedSkills?.get(nodePath.resolve(skill.path));
}

/**
 * Skills whose instructions this turn must carry inline. `providerInput` is the final
 * prompt without the inline block; omit it when native slash dispatch is not guaranteed
 * (steering a running turn), so Claude gets every skill inline.
 */
export function selectSkillsToInline(input: {
  readonly provider: ProviderKind;
  readonly skills: ReadonlyArray<ProviderSkillReference>;
  readonly providerInput?: string | undefined;
  readonly claudeConfigDir?: string | undefined;
  /**
   * SKILL.md path -> the name the provider lists the skill under, for skills
   * this session loads natively (Claude's skills plugin). Their full text
   * would otherwise enter the context twice: pasted here, then again when the
   * model calls its Skill tool on a skill it already has.
   */
  readonly nativelyServedSkills?: ReadonlyMap<string, string> | undefined;
}): ProviderSkillReference[] {
  const skills = input.skills.filter(
    (skill) => nativelyServedSkillName(skill, input.nativelyServedSkills) === undefined,
  );
  if (input.provider !== "claudeAgent") {
    return skills.filter((skill) => shouldInlineSkillForProvider(input.provider, skill.path));
  }
  // Mid-sentence, or behind Synara's goal, debug, project or recap text, `/name` reaches
  // Claude as plain words, so even a `.claude` skill must travel inline.
  const native =
    input.providerInput === undefined
      ? undefined
      : claudeNativelyLoadedSkill(input.providerInput, skills, input.claudeConfigDir);
  return skills.filter((skill) => skill !== native);
}

/** Skills this session serves natively under another name, each with that name. */
export function selectNativelyServedSkills(input: {
  readonly skills: ReadonlyArray<ProviderSkillReference>;
  readonly nativelyServedSkills?: ReadonlyMap<string, string> | undefined;
}): Array<{ readonly skill: ProviderSkillReference; readonly invoke: string }> {
  return input.skills.flatMap((skill) => {
    const invoke = nativelyServedSkillName(skill, input.nativelyServedSkills);
    return invoke === undefined ? [] : [{ skill, invoke }];
  });
}

/** Reads each skill file once per turn; unreadable files are skipped. Keyed by path. */
export async function loadInlineSkillBlocks(
  skills: ReadonlyArray<ProviderSkillReference>,
): Promise<ReadonlyMap<string, string>> {
  const entries = await Promise.all(
    skills.map(async (skill): Promise<readonly [string, string] | null> => {
      let content: string;
      try {
        content = await fs.readFile(skill.path, "utf8");
      } catch {
        return null;
      }
      let trimmed = content.trim();
      if (trimmed.length > MAX_INLINE_SKILL_CONTENT_CHARS) {
        trimmed = `${trimmed.slice(0, MAX_INLINE_SKILL_CONTENT_CHARS)}\n[skill content truncated]`;
      }
      const block = `<skill name=${JSON.stringify(skill.name)} dir=${JSON.stringify(
        nodePath.dirname(skill.path),
      )}>\n${trimmed}\n</skill>`;
      return [skill.path, block];
    }),
  );
  return new Map(entries.filter((entry) => entry !== null));
}

export function formatInlineSkillInstructions(input: {
  readonly skills: ReadonlyArray<ProviderSkillReference>;
  readonly blocks: ReadonlyMap<string, string>;
  readonly maxChars: number;
  /** Skills the session serves natively (`selectNativelyServedSkills`): pointers, not bodies. */
  readonly nativeSkills?: ReadonlyArray<{
    readonly skill: ProviderSkillReference;
    readonly invoke: string;
  }>;
}): string {
  if (input.maxChars <= 0) return "";
  let text = "";
  const nativeSkills = input.nativeSkills ?? [];
  if (nativeSkills.length > 0) {
    const pointers = nativeSkills
      .map(
        ({ skill, invoke }) =>
          `<skill name=${JSON.stringify(skill.name)} invoke=${JSON.stringify(
            invoke,
          )} path=${JSON.stringify(skill.path)} />`,
      )
      .join("\n");
    const candidate = `${NATIVE_SKILLS_HEADER}\n\n${pointers}`;
    if (candidate.length <= input.maxChars) {
      text = candidate;
    }
  }
  for (const skill of input.skills) {
    const block = input.blocks.get(skill.path);
    if (block === undefined) continue;
    const candidate = text.includes(INLINE_SKILLS_HEADER)
      ? `${text}\n\n${block}`
      : `${text.length === 0 ? "" : `${text}\n\n`}${INLINE_SKILLS_HEADER}\n\n${block}`;
    if (candidate.length > input.maxChars) {
      // Keep whatever already fits instead of overflowing the provider turn budget.
      break;
    }
    text = candidate;
  }
  return text;
}

export async function buildInlineSkillInstructions(input: {
  readonly provider: ProviderKind;
  readonly skills: ReadonlyArray<ProviderSkillReference>;
  readonly maxChars: number;
  readonly providerInput?: string | undefined;
  /** See `selectSkillsToInline`. */
  readonly nativelyServedSkills?: ReadonlyMap<string, string> | undefined;
}): Promise<string> {
  const nativeSkills = selectNativelyServedSkills(input);
  const inlineSkills = selectSkillsToInline(input);
  if ((nativeSkills.length === 0 && inlineSkills.length === 0) || input.maxChars <= 0) {
    return "";
  }
  return formatInlineSkillInstructions({
    skills: inlineSkills,
    blocks: await loadInlineSkillBlocks(inlineSkills),
    maxChars: input.maxChars,
    nativeSkills,
  });
}
