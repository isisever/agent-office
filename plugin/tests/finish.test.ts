import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { FINISH_REASON_MANAGER, FINISH_REASON_MENU_MANAGER, FINISH_REASON_MENU_SOLO, FINISH_REASON_SOLO, JUDGE_LABELS, assistantsPart, finishCues, heuristicBlocks } from '../hooks/finish'

// the finish guard (app contract v3.10): classic.Stop blocks a main-loop stop whose final message lists work
// the loop could still do, in manager mode and with AGENT_OFFICE_FINISH=1

type Harness = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]

const MANAGER = { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_MANAGER: '1' }
const LIST = 'Added `sum()` with tests.\n\n## Next steps\n- add docs\n- wire it into the CLI'
const APPROVAL = 'Everything is built and tested. Shall I deploy it to production?'
const DONE = 'Added `sum()` with tests; all of them pass.'
// two real final reports the guard blocked: what is left is the person's (update, choose, tell me if it fails), a
// future event, a wait for data, and a list of what was not verified
const RELEASES_TR = [
  'İki sürüm de yayında: 0.8.9 ve 0.9.0.',
  '',
  '**0.8.9:** Bitiş bekçisi artık ajanların bildirimlerini bekliyor; testler geçti, imzalı sürüm ve Homebrew cask güncellendi.',
  '',
  '**0.9.0:** Kullanım limitine gelince proje yedek hesapla devam ediyor. Testler ve tip denetimi geçti, sürüm imzalandı ve yayınlandı.',
  '',
  '**Doğrulanmayanlar:**',
  '- Gerçek bir kullanım limitinde geçiş henüz denenmedi; bu ancak ilk gerçek limitte yapılabilir.',
  '- Yedek hesabın oturumunun süresi dolmuşsa ne olacağı kontrol edilmedi.',
  '',
  'Sende yüklü olan hâlâ 0.8.8; uygulamanın içinden güncellersen ikisi birden gelir. Yedek hesap proje başına açılıyor, kullanmak istediğin projelerde bunu seçmen gerekiyor. İlk gerçek limitte proje yedek hesaba geçmezse haber ver, o konuşmanın kaydına bakıp düzeltirim.',
].join('\n')
const DATA_LATER = [
  'Both judge modes are now logged per session, with the label and the time it took.',
  '',
  'The comparison between the judge and the heuristic still needs real usage: it can only be done after a few days of data. Until then, you can keep the judge on (the default), or set `AGENT_OFFICE_FINISH_JUDGE=0` in the projects where you want the heuristic alone. If blocks feel too frequent, you could also lower the limit to one per prompt.',
].join('\n')

// a session in /work/my-app; the judge ($.model.classify) answers with `label` (a function: per call), or fails;
// the Stop hooks beneath answer `beneath`
function setUp(
  on: Harness,
  env: Record<string, string>,
  label: (() => string | undefined) | 'fails' = () => JUDGE_LABELS[0],
  beneath: { block?: string } = {},
) {
  const judged: string[] = []
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.root', () => ({ value: '/work/my-app' }))
  on('session.cwd', () => ({ value: '/work/my-app' }))
  on('command.register', () => ({ value: undefined as never }))
  on('clock.every', () => ({ value: undefined as never }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', (_$, e) => {
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_$, e) => e)
  on('model.classify', (_$, e) => {
    judged.push(e.text)
    if (label === 'fails') throw new Error('overloaded')
    return { value: label() }
  })
  on('classic.Stop', () => beneath)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { judged }
}

const start = { cwd: '/work/my-app', surface: 'terminal', isInteractive: true } as const
const stop = ($: Engine, message: string, more: Record<string, unknown> = {}) =>
  $.classic.Stop({ stop_hook_active: false, last_assistant_message: message, background_tasks: [], session_crons: [], ...more } as never)
const prompt = ($: Engine, text: string, kind = 'composer') => $.prompt.submit({ text, origin: { kind } } as never)

test('manager mode: a final message with next steps blocks the stop and says to do them through agents', async ($, on) => {
  const { judged } = setUp(on, MANAGER)
  await $.session.start(start)
  await prompt($, 'add a sum function')
  const answer = await stop($, LIST)
  expect(answer.block).toBe(FINISH_REASON_MANAGER)
  expect(answer.block).toContain('delegate the independent parts to sub-agents in parallel')
  expect(judged).toEqual([LIST])
})

// a claude started inside another one (app contract v3.12, nested sessions): its parent decides when it is done
test('a nested claude is never held back by the finish guard', async ($, on) => {
  const { judged } = setUp(on, { ...MANAGER, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'parent-1' })
  await $.session.start(start)
  await prompt($, 'add a sum function')
  expect((await stop($, LIST)).block).toBeUndefined()
  expect(judged).toEqual([])
})

test('a message with no work cue stops without asking the judge', async ($, on) => {
  const { judged } = setUp(on, MANAGER)
  await $.session.start(start)
  for (const message of [DONE, 'Which header colour do you prefer, blue or green?', '', 'Hepsi tamamlandı, kalan iş yok.'])
    expect((await stop($, message)).block).toBeUndefined()
  expect(judged).toEqual([])
})

test('a report whose rest is the person\'s, a future event or a wait stops without asking the judge', async ($, on) => {
  const { judged } = setUp(on, MANAGER)
  await $.session.start(start)
  await prompt($, 'release both')
  for (const message of [RELEASES_TR, DATA_LATER]) {
    expect(finishCues(message)).toEqual({ isWork: false, isAsk: false, isSoft: false, isMenu: false })
    expect((await stop($, message)).block).toBeUndefined()
  }
  expect(judged).toEqual([])
  // the judge reads only the assistant's part: the report's opening stays, the person's steps go
  expect(assistantsPart(RELEASES_TR)).toContain('İki sürüm de yayında')
  expect(assistantsPart(RELEASES_TR)).not.toContain('haber ver')
  expect(assistantsPart(RELEASES_TR)).not.toContain('Doğrulanmayanlar')
  expect(assistantsPart(LIST)).toBe(LIST)
})

test("the judge's label decides a message with a cue", async ($, on) => {
  const labels = [JUDGE_LABELS[1], JUDGE_LABELS[2], JUDGE_LABELS[0]]
  setUp(on, MANAGER, () => labels.shift())
  await $.session.start(start)
  expect((await stop($, LIST)).block).toBeUndefined()
  expect((await stop($, LIST)).block).toBeUndefined()
  expect((await stop($, 'Done. Want me to also add input validation?')).block).toBe(FINISH_REASON_MANAGER)
})

for (const [name, label] of [
  ['fails', 'fails'],
  ['names no label', () => 'maybe'],
] as const) {
  test(`when the judge ${name} the heuristic decides: a list blocks, an approval request stops`, async ($, on) => {
    setUp(on, MANAGER, label === 'fails' ? 'fails' : () => undefined)
    await $.session.start(start)
    expect((await stop($, APPROVAL)).block).toBeUndefined()
    expect((await stop($, 'Kod hazır. Canlıya almak için onay verir misin? Kalanlar: yok değil, README.')).block).toBeUndefined()
    expect((await stop($, LIST)).block).toBe(FINISH_REASON_MANAGER)
  })
}

test('a soft cue only goes to the judge: its label blocks; with no label the stop stands', async ($, on) => {
  const SOFT = "It only handles ASCII. If your blog has Turkish titles, that's the first thing to add next."
  const labels: (string | undefined)[] = [JUDGE_LABELS[0], undefined]
  const { judged } = setUp(on, MANAGER, () => labels.shift())
  await $.session.start(start)
  expect(heuristicBlocks(SOFT)).toBe(false)
  expect((await stop($, SOFT)).block).toBe(FINISH_REASON_MANAGER)
  expect((await stop($, SOFT)).block).toBeUndefined()
  expect(judged).toEqual([SOFT, SOFT])
})

test('AGENT_OFFICE_FINISH_JUDGE=0: no model call, the heuristic alone', async ($, on) => {
  const { judged } = setUp(on, { ...MANAGER, AGENT_OFFICE_FINISH_JUDGE: '0' })
  await $.session.start(start)
  expect((await stop($, 'Bitti. Kalanlar:\n- README güncellemesi\n- testler')).block).toBe(FINISH_REASON_MANAGER)
  expect((await stop($, APPROVAL)).block).toBeUndefined()
  expect(judged).toEqual([])
})

test("at most two blocks per prompt of the person's; a task notification does not reset the count", async ($, on) => {
  setUp(on, MANAGER)
  await $.session.start(start)
  await prompt($, 'build it')
  expect((await stop($, LIST)).block).toBe(FINISH_REASON_MANAGER)
  expect((await stop($, LIST, { stop_hook_active: true })).block).toBe(FINISH_REASON_MANAGER)
  expect((await stop($, LIST, { stop_hook_active: true })).block).toBeUndefined()
  await prompt($, '<task-notification>done</task-notification>', 'task-notification')
  expect((await stop($, LIST)).block).toBeUndefined()
  // the person's next prompt: two more
  await prompt($, 'and the docs')
  expect((await stop($, LIST)).block).toBe(FINISH_REASON_MANAGER)
})

test('never while background work or a cron will wake the loop, for a subagent, or after an error or an interrupt', async ($, on) => {
  setUp(on, MANAGER)
  await $.session.start(start)
  const agent = { id: 'a1', type: 'subagent', status: 'running', description: 'write the docs' }
  expect((await stop($, LIST, { background_tasks: [agent] })).block).toBeUndefined()
  expect((await stop($, LIST, { session_crons: [{ id: 'c1' }] })).block).toBeUndefined()
  expect((await stop($, LIST, { agent_id: 'agent-1' })).block).toBeUndefined()
  // a finished background task no longer counts
  expect((await stop($, LIST, { background_tasks: [{ ...agent, status: 'completed' }] })).block).toBe(FINISH_REASON_MANAGER)
  for (const reason of ['error', 'aborted']) {
    await $.turn.start({ text: 'go', turnId: 'turn-1' })
    await $.turn.complete({ reason, answer: LIST, durationMs: 1, isAborted: reason === 'aborted', turnId: 'turn-1' } as never)
    expect((await stop($, LIST)).block).toBeUndefined()
  }
  // a turn that answered: the guard is back
  await $.turn.start({ text: 'go', turnId: 'turn-2' })
  await $.turn.complete({ reason: 'answer', answer: LIST, durationMs: 1, isAborted: false, turnId: 'turn-2' } as never)
  expect((await stop($, LIST)).block).toBe(FINISH_REASON_MANAGER)
})

test('a prompt that asks for the list itself is answered by the list; asking to finish what is left is not', async ($, on) => {
  setUp(on, MANAGER)
  await $.session.start(start)
  for (const asked of [
    'Add add(a, b) to math.js and end your reply with a list of follow-up improvements.',
    'Just a plan for the login page, do not implement it yet.',
    'Login sayfası için sonraki adımları listele.',
    'Bu modül için ne önerirsin?',
  ]) {
    await prompt($, asked)
    expect((await stop($, LIST)).block).toBeUndefined()
  }
  for (const asked of ['Kalan işleri de yap.', 'Finish what is left on the list.', 'Uygulamaya dark mode ekle.']) {
    await prompt($, asked)
    expect((await stop($, LIST)).block).toBe(FINISH_REASON_MANAGER)
  }
})

test('a block from the hooks beneath stands as it is', async ($, on) => {
  setUp(on, MANAGER, undefined, { block: 'run the linter first' })
  await $.session.start(start)
  expect((await stop($, LIST)).block).toBe('run the linter first')
})

test('manager mode off: no guard; AGENT_OFFICE_FINISH=1 ("does it itself") guards without the delegation wording', async ($, on) => {
  const env: Record<string, string> = { HOME: '/home/tester', AGENT_OFFICE_APP: '1' }
  const { judged } = setUp(on, env)
  await $.session.start(start)
  expect((await stop($, LIST)).block).toBeUndefined()
  env.AGENT_OFFICE_MANAGER = '0'
  expect((await stop($, LIST)).block).toBeUndefined()
  expect(judged).toEqual([])
  env.AGENT_OFFICE_FINISH = '1'
  const answer = await stop($, LIST)
  expect(answer.block).toBe(FINISH_REASON_SOLO)
  expect(answer.block).not.toContain('sub-agents')
})

// a real manager's final turn (v3.52): analysis, a recommendation, then a menu and an offer to commit
const MENU_S3D =
  'Analiz tamam: mevcut modelde gövde tek parça değil. Önerim: önce eskiz ve extrude, sonra boolean birleştirme. Hangisiyle devam edelim? Ayrıca henüz commit atmadım; değişiklikleri kaydetmemi isterseniz söyleyin.'
const MENUS: string[] = [
  MENU_S3D,
  'İki yol var: A daha hızlı, B daha temiz. Hangisinden başlayayım?',
  'Önce eskiz mi yapalım, boolean mı?',
  'Seçeneklerden hangisi daha hızlı olur, hangisiyle başlayayım?',
  'Değişiklikleri commit etmemi ister misiniz?',
  'Analysis done: option A is faster, option B is cleaner. Which should I start with?',
  'I recommend the parser first. Which one should we do first?',
  'The refactor is half done. Shall we continue?',
  'Should I go with the SQLite store or the JSON file?',
  "Let me know how you'd like to proceed.",
  'Ne yapalım?',
  'A mı yoksa B mi olsun?',
  'Which would you like first, A or B?',
]
// the ask wins: a sentence with an ask topic is never a menu, even in a menu's shape
const REAL_ASKS: string[] = [
  'Deploy etmemi onaylıyor musunuz?',
  'API anahtarınızı girmeniz gerekiyor.',
  'Shall I proceed with the production deploy?',
  'Should I commit and push to main?',
  'Do you want me to proceed with deleting the old bucket?',
  'Eski tabloyu silmeye devam edeyim mi?',
  'Release notlarını commit etmemi ve yayınlamamı onaylıyor musunuz?',
  'Onaylarsanız deploy işlemine devam edelim.',
  'Should we use Stripe or Paddle for billing?',
  // a product preference phrased as theirs
  'Header için seçeneklerden hangisini tercih edersiniz?',
  'Hangisini tercih edersiniz?',
]
// narrative, not a question: Turkish menu cues need a "?", and "mı/mi" is a whole word
const NARRATIVE: string[] = [
  'Testler geçti; devam edelim dedim ve ikinci modülü de bitirdim.',
  'Mümkün olduğunca mimari sadeleştirildi, şimdi sonuca gelelim: build yeşil.',
  'Mutlu yol test edildi, diyelim ki eksik yok.',
]

test('the ask wins over a menu, and narrative is no menu', () => {
  expect(REAL_ASKS.filter(message => heuristicBlocks(message))).toEqual([])
  expect(REAL_ASKS.filter(message => finishCues(message).isMenu || !finishCues(message).isAsk)).toEqual([])
  expect(NARRATIVE.filter(message => heuristicBlocks(message))).toEqual([])
  expect(NARRATIVE.filter(message => finishCues(message).isMenu)).toEqual([])
})

test('a menu (which option, what first, whether to go on or commit) blocks with its own reason, whatever the judge says', async ($, on) => {
  setUp(on, MANAGER, () => JUDGE_LABELS[1])
  await $.session.start(start)
  expect(MENUS.filter(message => !heuristicBlocks(message))).toEqual([])
  expect(MENUS.filter(message => !finishCues(message).isMenu)).toEqual([])
  expect(REAL_ASKS.filter(message => heuristicBlocks(message))).toEqual([])
  await prompt($, 'model the S3D part')
  const answer = await stop($, MENU_S3D)
  expect(answer.block).toBe(FINISH_REASON_MENU_MANAGER)
  expect(answer.block).toContain('you ended on a menu')
  for (const message of REAL_ASKS) expect((await stop($, message)).block).toBeUndefined()
  // still at most two blocks per prompt
  expect((await stop($, MENUS[1])).block).toBe(FINISH_REASON_MENU_MANAGER)
  expect((await stop($, MENUS[2])).block).toBeUndefined()
})

test('a pure menu blocks even when the judge says it is the person\'s decision (label 2)', async ($, on) => {
  setUp(on, MANAGER, () => JUDGE_LABELS[2])
  await $.session.start(start)
  await prompt($, 'pick a store')
  expect((await stop($, 'Ne yapalım?')).block).toBe(FINISH_REASON_MENU_MANAGER)
  // a real ask under the same label still stops
  expect((await stop($, 'Shall I proceed with the production deploy?')).block).toBeUndefined()
})

test('a menu in the "does it itself" mode gets the solo wording', async ($, on) => {
  setUp(on, { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_FINISH: '1' })
  await $.session.start(start)
  await prompt($, 'model the S3D part')
  expect((await stop($, MENU_S3D)).block).toBe(FINISH_REASON_MENU_SOLO)
})

// the heuristic alone (the judge's fallback), Turkish and English
const BLOCKS: string[] = [
  LIST,
  'Bitti. Kalanlar:\n- README güncellemesi\n- testler',
  'Bundan sonra şunlar yapılacak: lint düzeltmeleri, testler.',
  'Tamam, istersen dark mode da ekleyeyim?',
  'Want me to also add input validation?',
  'Deploy script added. Next steps:\n1. add tests\n2. add docs',
  'Tests pass; I could also add a benchmark if useful.',
  '**Sonraki adımlar**\n1. Hata mesajlarını Türkçeleştirmek\n2. E2E testleri',
  'Done for now. Remaining work: the settings page is not implemented yet.',
  'Login formu hazır. Şifre sıfırlama henüz yapılmadı, sonra yapılabilir.',
  "The module is done. If you want any of the follow-ups from the list, say which and I'll dispatch them.",
  'Hazır. Testleri de yazmamı söylersen eklerim.',
  'Kapsam: başka komut yok. İzin verirsen iki `add`, boş metin ve bozuk `todos.json` senaryolarını çalıştırıp sonucu bildiririm.',
  "With your permission, I'll run the full test suite next.",
  'Turkish letters are dropped. If your titles use them, I can add a character map in the next version.',
  'It only handles ASCII. If your blog has Turkish titles, the next step would be adding a transliteration map.',
  // a list stays a list when some of its items are the person's
  "## Next steps\n- add tests\n- you'll need to set the env var on Vercel",
  'Kalanlar:\n- README\n- Uygulamayı güncellersen yeni ayar görünür.',
  'Done for now. The settings page is not implemented yet; you can use the old one meanwhile.',
  "If you'd like, I can add a retry once the API fails again.",
  'Eklentiyi sen seçersen kurulumu ben yaparım; testler henüz yapılmadı.',
  ...MENUS,
]
const STOPS: string[] = [
  DONE,
  'Done; all tests pass. Nothing left to do.',
  'Hepsi tamamlandı, kalan iş yok.',
  APPROVAL,
  'Kod hazır ve testler geçti. Canlıya almak için onay verir misin?',
  'Which do you prefer for the header: blue or green?',
  'Header için hangisini istersin: A mı B mi?',
  'Added the function. I need your API token to test against the real service, please.',
  'Fixed the bug in `todo.js` and removed the `// TODO` comment.',
  'Next steps (for you): log in to Vercel and approve the deploy.',
  'Agents are working on it; I will integrate when they report.',
  'Değişiklik tamam. Bu ayar bundan sonra her açılışta uygulanır.',
  'Kaydı silmemi ister misin?',
  'Eski tabloları silmek geri alınamaz: sileyim mi?',
  'Done. To finish the release I need you to sign in to npm (`npm login`); everything else is done.',
  'Let me know if anything else comes up.',
  'Build passes. İzin verirsen canlıya alırım.',
  "Everything else is done; with your permission I'll publish 1.2.0 to npm.",
  'Here is the plan:\n```\n// TODO: next steps\n```\nAll implemented and verified.',
  RELEASES_TR,
  DATA_LATER,
  // the person's steps, future events, waits, and what was not verified
  'Sürüm yayında. Uygulamayı içinden güncellemelisin; ayarı kullanmak istediğin projede sen seç.',
  'Done. You can now run it with `npm start`; you will need to restart the app once.',
  'Fixed. If the crash happens again, let me know and I will look at the logs.',
  'Kaydedildi. Bir hata çıkarsa haber ver, sonra bakarım.',
  'Ölçüm açık. Karşılaştırma ancak birkaç gün sonra yapılabilir.',
  ...REAL_ASKS,
  'Released 1.4.0.\n\n**Not verified:**\n- the Windows build still needs a real machine\n- the next steps of the wizard on a slow network',
]

test('the heuristic: lists, next steps and offers block; finished reports and requests to the person stop', () => {
  expect(BLOCKS.filter(message => !heuristicBlocks(message))).toEqual([])
  expect(STOPS.filter(message => heuristicBlocks(message))).toEqual([])
})
