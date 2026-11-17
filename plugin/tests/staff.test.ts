import { expect, test } from 'claude-code/testing'
import { memberText, parseMember, STAFF_SECTION_ID, TEAM_SECTION_ID, TEAM_TEXT } from '../hooks/staff'

const file = { format: 2, member: 'Ayşe', name: 'ERP Developer (Odoo)', description: 'Builds Odoo modules.', brief: 'Never edit Odoo core.', writesCode: true, department: 'Development', project: { name: 'acme', dir: '/work/acme' }, team: [{ name: 'Mert', role: 'QA Engineer' }, { name: 'Deniz', role: 'DevOps Engineer' }] }

test('section ids (v3.83)', () => {
  expect(STAFF_SECTION_ID).toBe('agent-office:staff')
  expect(TEAM_SECTION_ID).toBe('agent-office:team')
})

test('parseMember: a valid file; malformed, nameless or projectless files give undefined', () => {
  expect(parseMember(JSON.stringify(file))?.member).toBe('Ayşe')
  expect(parseMember('{')).toBeUndefined()
  expect(parseMember(JSON.stringify({ ...file, member: '' }))).toBeUndefined()
  expect(parseMember(JSON.stringify({ ...file, project: { name: 'x' } }))).toBeUndefined()
  // backticks and control characters never reach the prompt
  expect(parseMember(JSON.stringify({ ...file, brief: 'a`b\u0007c' }))?.brief).toBe('a b c')
})

test('memberText: who, the role, the project and its rules, the brief, the rest of the team', () => {
  const t = memberText(parseMember(JSON.stringify(file))!)
  expect(t).toContain("# You are Ayşe, the team's ERP Developer (Odoo)")
  expect(t).toContain('in Development')
  expect(t).toContain('on the project acme (/work/acme)')
  expect(t).toContain(".claude/rules/")
  expect(t).toContain('Never edit Odoo core.')
  expect(t).toContain('- Mert: QA Engineer')
  expect(t).not.toContain('does not write or change code')
  expect(memberText(parseMember(JSON.stringify({ ...file, writesCode: false, team: [] }))!)).toContain('does not write or change code')
})

test('team text: staff by role, desks and the folder lock, developer → QA → DevOps', () => {
  expect(TEAM_TEXT).toContain('office_dispatch with staff')
  expect(TEAM_TEXT).toContain('one project folder has one desk at work at a time')
  expect(TEAM_TEXT).toContain('its test is a separate task for QA after the developer reports')
  expect(TEAM_TEXT).toContain('Deployment belongs to the DevOps member, never to a developer')
  expect(TEAM_TEXT).toContain('Production deployments only when the person asked for them')
})
