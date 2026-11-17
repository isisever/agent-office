// Team: staff (app contract v3.81). Two sections, each keyed on its own env var and independent of the manager and HQ
// sections (their templates are untouched):
// - agent-office:staff — a desk's session (a staff member's tab): the app writes the member's file (0600; name, role,
//   brief, department, the project, the rest of the team by name and role) and passes its path in AGENT_OFFICE_ROLE.
// - agent-office:team — HQ while the person has a team (AGENT_OFFICE_TEAM=1): give work to members by role.
// The app sets neither without a team, so a session then gets exactly what it got before.

export const STAFF_SECTION_ID = 'agent-office:staff'
export const TEAM_SECTION_ID = 'agent-office:team'

const line = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f`]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '')
const block = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f`]+/g, ' ').trim().slice(0, max) : ''

export type Member = {
  member: string
  role: string
  description: string
  brief: string
  writesCode: boolean
  department: string
  project: { name: string; dir: string }
  team: { name: string; role: string }[]
}

/** The member in the app's file; undefined for a missing, malformed or nameless one. */
export function parseMember(raw: string): Member | undefined {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (data === null || typeof data !== 'object') return undefined
  const o = data as Record<string, unknown>
  const member = line(o.member, 40)
  const role = line(o.name, 80)
  const p = (o.project && typeof o.project === 'object' ? o.project : {}) as Record<string, unknown>
  const project = { name: line(p.name, 200), dir: line(p.dir, 1024) }
  if (!member || !role || !project.dir) return undefined
  const team = (Array.isArray(o.team) ? o.team : [])
    .flatMap((x: unknown) => {
      const r = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
      const n = line(r.name, 40)
      return n ? [{ name: n, role: line(r.role, 80) }] : []
    })
    .slice(0, 20)
  return {
    member, role, description: line(o.description, 400), brief: block(o.brief, 4000), writesCode: o.writesCode !== false,
    department: line(o.department, 30), project, team,
  }
}

/** The member's section. */
export function memberText(m: Member): string {
  const parts = [`# You are ${m.member}, the team's ${m.role} (Agent Office team)

You are a member of the person's team in Agent Office${m.department ? `, in ${m.department}` : ''}${m.description ? `. Your role: ${m.description}` : ''}. You work here on the project ${m.project.name || m.project.dir} (${m.project.dir}); work reaches you from the person or from HQ, the team's manager. Before you work, read the project's CLAUDE.md and the files in its .claude/rules/ when they exist, and follow them.`]
  if (m.brief) parts.push(m.brief)
  if (!m.writesCode) parts.push('Your role does not write or change code, configuration or data: you read them and produce documents.')
  if (m.team.length)
    parts.push(`The rest of the team (HQ gives them their own tasks; say in your report what the next member should do, do not do their part):
${m.team.map(t => `- ${t.name}: ${t.role}`).join('\n')}`)
  parts.push("The person's own instructions (CLAUDE.md, explicit requests) take precedence over this.")
  return parts.join('\n\n')
}

export const TEAM_TEXT = `# The team (Agent Office)

The person has a team in Agent Office: office_machines lists its staff on this machine with each member's role, description, department, the projects it may work on and its desks (busy or idle). Give work to the member whose role fits: office_dispatch with staff (the member's name) and project (one of the member's projects). Each member works at its own desk (session) with its own account and role; a member can work on several projects at the same time, and one project folder has one desk at work at a time, so a task may wait for the folder. A member that does not write code gets documents to produce, never code changes. Work without a fitting member goes to the project's boss as before (office_dispatch without staff). Work for a member that belongs to no project goes to the member's personal workspace: office_dispatch with staff and without project.

Work like a real team when the team has the roles for it. A developer's change is not finished until QA has tested it: when there is a QA member, its test is a separate task for QA after the developer reports, never the developer's own job, and it names what changed (the commits or branch from the developer's report). Deployment belongs to the DevOps member, never to a developer: it is a separate task after QA reports a PASS, naming what to deploy; a QA FAIL goes back to the developer with QA's bug report, not to DevOps. Production deployments only when the person asked for them. Send these steps as stages of one request (office_dispatch \`then\`) when the tool offers it, otherwise one after another as each step reports. Analysis questions about data go to the data analyst.`
