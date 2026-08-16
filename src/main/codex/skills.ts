import type { SlashCommandInfo } from '@shared/types'
import type { SkillMetadata, SkillsListResponse } from './wire'

export interface CachedSkill extends SkillMetadata {
  name: string
  path: string
  description: string
  scope: 'user' | 'repo' | 'system' | 'admin'
}

export class CodexSkillsCache {
  private pending = new Map<string, Promise<CachedSkill[]>>()
  private resolved = new Map<string, CachedSkill[]>()
  private generation = 0

  constructor(private fetch: (cwd: string) => Promise<SkillsListResponse>) {}

  list(cwd: string): Promise<CachedSkill[]> {
    const cached = this.pending.get(cwd)
    if (cached) return cached

    const generation = this.generation
    const request = this.fetch(cwd).then((response) => {
      const skills = response.data.flatMap((entry) => entry.skills).filter(isUsableSkill)
      if (this.generation === generation) this.resolved.set(cwd, skills)
      return skills
    })
    this.pending.set(cwd, request)
    request.catch(() => {
      // 실패를 영구 캐시하면 CLI 복구 뒤에도 자동완성이 살아나지 않는다.
      if (this.pending.get(cwd) === request) this.pending.delete(cwd)
    })
    return request
  }

  find(cwd: string, name: string): CachedSkill | undefined {
    return this.resolved.get(cwd)?.find((skill) => skill.name === name)
  }

  invalidate(): void {
    // skills/changed 는 어떤 cwd 가 바뀌었는지 싣지 않으므로 전부 버린다.
    this.pending.clear()
    this.resolved.clear()
    this.generation += 1
  }
}

export function mergeSkillCommands(
  commands: SlashCommandInfo[],
  skills: CachedSkill[]
): SlashCommandInfo[] {
  const names = new Set(commands.map((command) => command.name))
  const additions: SlashCommandInfo[] = []
  for (const skill of skills) {
    if (names.has(skill.name)) continue
    names.add(skill.name)
    const summary = skill.interface?.shortDescription ?? skill.shortDescription
    additions.push({
      name: skill.name,
      description: `${summary || skill.description} (${skill.scope})`
    })
  }
  return [...commands, ...additions]
}

function isUsableSkill(skill: SkillMetadata): skill is CachedSkill {
  return (
    skill.enabled === true &&
    typeof skill.name === 'string' &&
    typeof skill.path === 'string' &&
    typeof skill.description === 'string' &&
    typeof skill.scope === 'string'
  )
}
