// The finish guard (app contract v3.10): the main loop must not go idle with a list of work it could still do.
// When it is about to stop (classic.Stop, the main loop's own; a subagent's stop is SubagentStop and never seen
// here), its final message is read: a list of remaining work or next steps, or an offer to do more ("want me
// to…?", "istersen … yapayım"), blocks the stop and Claude carries on with the block's reason as its next
// instruction (the classic Stop hook's `decision: "block"`). A message that asks the person for what only they
// can give (an approval for an outward-facing or destructive step, credentials, a decision of theirs) stops.
//
// On in manager mode (AGENT_OFFICE_MANAGER=1) and in the "does it itself" mode (AGENT_OFFICE_FINISH=1, the app's
// per-project setting): delegating or not, no project ends a turn on a to-do list.
//
// Deciding: first the person's part is taken out (steps only they can take, "haber ver" / "let me know if…", waits
// on a future event or on days of data, a "not verified" section), then a heuristic over the rest (Turkish and
// English) finds the cues; a message with none stops at once, no model call. One with a work cue, or only a soft one (next, later, could, also, sonra, eksik, …), goes to a
// fast-model judge ($.model.classify) when the judge is on; its label decides. When the judge fails, names no label
// or runs past the hook's budget, the heuristic decides alone: a work cue with no request to the person blocks;
// with one, or with only soft cues, it stops (a wrong stop costs one prompt from the person, a
// wrong block costs a turn). Loop safety: at most FINISH_BLOCKS_MAX blocks per prompt of the person's, and never
// while background work is in flight (agents, shells, monitors: their notifications wake the loop again and
// the guard reads the next stop) or a session cron will wake it, nor after a turn that ended on an error or an
// interrupt.
//
// Menus (v3.52): a question that hands the assistant's own choice back to the person ("Hangisiyle devam edelim?",
// "önce eskiz mi yapalım, boolean mı?", "which should I start with?", "shall we continue?", "commit etmemi ister
// misiniz?") is no decision of theirs: which option, what first, whether to go on or commit is the assistant's to
// make. Such a sentence is a work cue, never counts as a request to the person, and blocks even against the
// judge's label with its own reason (FINISH_REASON_MENU_*). Real asks (approve, deploy, publish, delete, spend,
// credentials, login, a product decision phrased as theirs: "which do you prefer for the header?") still stop.

export const FINISH_BLOCKS_MAX = 2
// the judge reads at most this much of the message: the end, where the lists and the questions are
const JUDGE_CHARS = 4000

export const FINISH_REASON_MANAGER =
  'Agent Office: you listed remaining work. Do it now: delegate the independent parts to sub-agents in parallel, then review, integrate and verify. Stop only when the list is done or you need the person for an approval, credential or decision that is theirs; then ask in one short list.'
export const FINISH_REASON_SOLO =
  'Agent Office: you listed remaining work. Do it now, then verify it. Stop only when the list is done or you need the person for an approval, credential or decision that is theirs; then ask in one short list.'

export const FINISH_REASON_MENU_MANAGER =
  "Agent Office: you ended on a menu. Choose yourself (the one you recommended, reason in one line) and carry on: delegate the independent parts to sub-agents in parallel, then review, integrate and verify. Ask only for approvals, credentials or decisions that are the person's."
export const FINISH_REASON_MENU_SOLO =
  "Agent Office: you ended on a menu. Choose yourself (the one you recommended, reason in one line) and carry on, then verify. Ask only for approvals, credentials or decisions that are the person's."

// the judge's labels: the classifier answers with one of them, so each says what it means
export const JUDGE_LABELS = [
  'lists or offers more work the assistant could still do itself now, or asks the user to pick among options, choose what to do first, or confirm continuing or committing',
  "asks the user for an approval of an outward-facing or destructive step (deploy, publish, delete, spend), credentials or a login, or a product decision that is theirs, or leaves them a step only they can take; technical choices and the order of the work are not the user's decision",
  'reports finished work with nothing left to do',
] as const

// lower case for matching: Turkish dotted/dotless I folded so "KALANLAR", "İstersen" and "Istersen" all match
export function fold(text: string) {
  return text.replace(/İ/g, 'i').replace(/I/g, 'i').toLowerCase().replace(/\u0307/g, '')
}

// code is not prose: a TODO in a snippet or a `next` in a command is no list of the assistant's
function prose(text: string) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
}

// `\b` is ASCII-only in JS: here `<` marks where a word starts (no letter or digit before it) and `>` where one
// ends (none after it); a stem left open takes Turkish suffixes ("onay" matches "onaylıyor musun")
const re = (source: string) =>
  new RegExp(source.replace(/</g, '(?<![\\p{L}\\p{N}])').replace(/>/g, '(?![\\p{L}\\p{N}])'), 'mu')

// "nothing left": removed before the cues are looked for, so a finished report is not read as a list
const NOTHING_LEFT = new RegExp(
  [
    'nothing (?:else )?(?:left|remaining|remains|more|pending)(?: to (?:do|be done))?',
    'no (?:remaining|open|pending|further|outstanding) (?:work|tasks?|items?|steps?|todos?)',
    'no (?:next steps|follow[- ]?ups?|todos?)',
    'there (?:are|is) no (?:more |further )?(?:remaining|next steps?|follow[- ]?ups?|todos?)',
    'all (?:tasks? |items? |steps? )?(?:are )?(?:done|complete|completed|finished)',
    'kalan (?:bir )?(?:iş|görev|adım|madde)\\p{L}* (?:yok|kalmadı)',
    'yapılacak (?:başka )?(?:bir )?(?:şey|iş)\\p{L}* (?:yok|kalmadı)',
    '(?:başka )?(?:açık|bekleyen|eksik) (?:bir )?(?:iş|madde|şey)\\p{L}* (?:yok|kalmadı)',
    'hepsi (?:tamamlandı|bitti)',
    'her şey (?:tamam|tamamlandı|bitti)',
  ].join('|'),
  'gu',
)

// offers of more work: a sentence with one stays even when it also addresses the person ("if you want any, say which")
const OFFER_CUES: RegExp[] = [
  re(String.raw`<(?:want me to|would you like me to|do you want me to|shall i|should i (?:also|go ahead|continue|proceed)|i (?:can|could) also|could also be|if you(?:'d| would) like,? i(?:'ll| can| could)|let me know if you(?:'d like| want)|if you want (?:any|me|more|one|some|the)|say (?:which|the word)|i(?:'ll| will) (?:dispatch|add|do|implement) (?:them|those|it)|happy to (?:also )?(?:add|do|implement|write|look))`),
  re(String.raw`<next,? (?:i|we|you) (?:can|could|should|would)>`),
  re(String.raw`<(?:the |a |one )?(?:natural |logical |obvious |good )?next steps? (?:would|could|might|should|is|are|will)>`),
  re(String.raw`<i (?:can|could) (?:add|implement|extend|write|build|wire|set up|make|handle|include|support|refactor|split|cover)>`),
  re(String.raw`<(?:ister(?:sen|seniz|misin|mısın|miniz|misiniz)|söylersen|söylerseniz|dersen|derseniz|izin verirsen|izin verirseniz|uygun görürsen|uygun görürseniz)>`),
  // an offer behind a request for permission: the permission is not the point, the work is
  re(String.raw`<(?:with your (?:ok|permission|go-ahead)|if you(?:'re| are) ok with (?:it|that),? i)`),
  // "ekleyeyim mi?", "yapayım mı", "devam edeyim mi", "geçeyim mi": an offer in the form of a question
  re(String.raw`\p{L}+(?:ayım|eyim) m[ıi]>`),
]

// a heading, or a line led by one (markdown heading, bold, a list number, or a plain "Label:")
const HEADING_CUE = re(
  String.raw`(?:^|[.!:;]\s+)[\s#*_-]*(?:\d+[.)]\s*)?(?:next steps?|remaining(?: work| tasks| items| steps)?|still to do|to ?dos?|follow[- ]?ups?|future work|left to do|what'?s left|open items|pending(?: work| tasks| items)?|possible improvements|suggested (?:improvements|next steps)|kalanlar|kalan (?:işler|adımlar|görevler|maddeler)|sonraki adımlar?|bir sonraki adım|yapılacaklar|eksikler|açık kalanlar|bekleyen işler|sonra yapılabilecekler|ileride yapılabilecekler|öneriler)>[^\n]{0,40}?(?::|\*\*|$)`,
)

// work announced as not done yet
const NOT_DONE_CUES: RegExp[] = [
  re(String.raw`<(?:as a next step|in a follow[- ]?up|left for later|still needs? |(?:is|are) not (?:yet )?(?:done|implemented|handled|covered)|not (?:done|implemented|handled|covered) yet)`),
  re(String.raw`<(?:in|for) (?:the|a) (?:next|later|future|second) (?:version|iteration|pass|round|step)>`),
  re(String.raw`<todo>`),
  re(String.raw`<(?:bundan sonraki adım|sonraki sürüm|bir sonraki adımda|ilerleyen adım|sonraki aşama|daha sonra yap|ileride yap|henüz (?:yapılmadı|eklenmedi|bitmedi|tamamlanmadı))`),
  re(String.raw`<yapılacak(?:lar|tır)?>`),
  re(String.raw`<yapılabil(?:ir|ecek)`),
]

// a menu: the assistant's own choice handed back to the person (which option, what first, whether to go on or commit)
const MENU_CUES: RegExp[] = [
  // "hangisiyle devam edelim", "hangisinden başlayayım", "hangi seçenekle ilerleyelim", "hangisini yapayım"
  re(String.raw`<hangi\p{L}*[^.?!\n]{0,40}?(?:başla|devam ed|devam et|ilerle|geç|yap|git|gid|seç|uygula|al)\p{L}*(?:elim|alım|eyim|ayım)>`),
  re(String.raw`<seçenek\p{L}*(?:den|dan) hangi`),
  re(String.raw`<(?:önce|ilk olarak|ilk) (?:hangi|ne)\p{L}*[^.?!\n]{0,30}?\p{L}(?:elim|alım|eyim|ayım)>`),
  // "devam edelim mi", "devam etmemi ister misiniz", "kaydetmemi / commit etmemi / commit atmamı ister misiniz"
  re(String.raw`<devam (?:edeyim|edelim|etmemi|edilsin|etmeli miyim|etmeli miyiz)>`),
  re(String.raw`<(?:kaydet|commit (?:et|at)|commitle)\p{L}*(?:memi|mamı|eyim|ayım|elim|alım)>`),
  // "which should I start with / do first / go with", "what should we tackle first"
  re(String.raw`<(?:which|what)(?: one| option| approach| of (?:these|them|the \p{L}+))? (?:should|shall|do you want) (?:i|we|me to)(?: to)? (?:start|begin|do|go|tackle|pick|take|implement|use|work on|continue|proceed)`),
  re(String.raw`<which (?:would you like|do you want) (?:me )?(?:to )?(?:start with|do first|go with|tackle|pick)`),
  // "shall we continue", "should I proceed", "shall I commit"
  re(String.raw`<(?:shall|should) (?:i|we) (?:continue|proceed|go on|keep going|carry on|start with|go with|commit)>`),
  re(String.raw`<(?:do you want|would you like) (?:me to |us to )?(?:continue|proceed|keep going|commit)>`),
  // "should I do A or B?"
  re(String.raw`<(?:shall|should) (?:i|we) [^.?!\n]{1,60} or [^.?!\n]{1,60}\?`),
]
// "A mı B mi?" with a first person plural or singular of the assistant's ("önce eskiz mi yapalım, boolean mı?")
const PAIRED_QUESTION = re(String.raw`<m[ıiuü]\p{L}{0,4}>[^.?!\n]{1,60}<m[ıiuü]\p{L}{0,4}>`)
const OWN_ACTION = re(String.raw`\p{L}(?:elim|alım|eyim|ayım)>`)

function isMenu(sentence: string) {
  const text = fold(prose(sentence))
  return MENU_CUES.some(cue => cue.test(text)) || (PAIRED_QUESTION.test(text) && OWN_ACTION.test(text))
}

// the work cues: a list of what is left, next steps, or an offer to do more
const WORK_CUES: RegExp[] = [HEADING_CUE, ...OFFER_CUES, ...NOT_DONE_CUES]

// what only the person can give: approvals for outward-facing or destructive steps, credentials, their decisions
const ASK_TOPICS: RegExp[] = [
  re(String.raw`<(?:approv|confirm|deploy|production>|prod>|go live|publish|release|push(?:ed|ing)? to (?:main|master|origin|remote|prod)|delet|drop (?:the )?(?:table|database)|wipe|erase|spend|billing|payment|purchase|pay for|credential|password|passphrase|token|api key|secret|log ?in>|sign ?in>|2fa|otp>|(?:do|would) you prefer)`),
  // a product decision phrased as theirs: "hangisini istersin", "tercihiniz", "sizin kararınız"
  re(String.raw`<(?:onay|canlı|yayın|deploy|prod>|sil(?:mek|me|eyim|elim|inecek|insin|ineceğ)|kaldırayım|şifre|parola|token|anahtar|giriş yap|oturum aç|kimlik|karar|hangisini (?:istersin|istersiniz|tercih edersin|tercih edersiniz)|tercihin|ödeme|para>|satın|ücret|maliyet)`),
]
// a request in that same sentence: a question, or an explicit ask of the person ("you need to log in")
const REQUEST = re(
  String.raw`\?|<(?:please|need your|needs your|with your (?:ok|permission|go-ahead)|izin verirsen|waiting for you|for you>|you(?:'ll| will)? need to|you have to|on your side|lütfen|senden|sizden|gerekiyor|bekliyorum|onaylarsan|senin|sizin|yapman|yapmanız)`,
)

// sentences (and lines): an ask is a topic and a request in one of them, not a topic mentioned in a report
function sentencesOf(text: string) {
  return text.split(/\n+|(?<=[.!?])\s+/u).filter(Boolean)
}

// What is the person's, not the assistant's: these sentences are taken out before the cues are looked for (and before
// the judge reads the message), so a step left to the person, a wait for a future event or a list of what was not
// verified is no list of remaining work. A sentence with an offer or a heading of the assistant's always stays.
//
// addressed to the person: "you can", "you'll need to", "let me know if…", "-melisin", "-men gerekiyor", "haber ver"
const ADDRESSED: RegExp[] = [
  re(String.raw`<you(?:'ll| will| would| may| might| can| could| should| must| need| have to|'d need| want to)>`),
  re(String.raw`<(?:let me know|tell me|ping me) (?:if|when|once|whether)>`),
  re(String.raw`\p{L}+(?:melisin|malısın|melisiniz|malısınız|meniz|manız|men|man) gerek`),
  re(String.raw`\p{L}+(?:abilirsin|ebilirsin|abilirsiniz|ebilirsiniz)>`),
  re(String.raw`<(?:haber ver|bana (?:yaz|söyle|bildir)|sen seç|siz seç|güncelle(?:yin|yiniz)?>|güncellemen|yeniden başlat(?:man|ın|ırsan))`),
]
// the person's own "-rsen" ("güncellersen ikisi birden gelir") is theirs, unless the assistant promises work on it
// ("uygun bulursan eklerim"): then it is an offer
const OWN_CONDITIONAL = re(String.raw`\p{L}+(?:rsen|rsan|rseniz|rsanız)>`)
const FIRST_PERSON = re(String.raw`\p{L}+(?:rım|rim|rum|rüm|ceğim|cağım|eyim|ayım)>`)
// waiting on a future event or on time: nothing the assistant can do now, whatever else the sentence says
const LATER: RegExp[] = [
  // Turkish third-person conditional: "geçmezse", "olursa", "varsa"
  re(String.raw`\p{L}+(?:rse|rsa|mezse|mazsa)>|<(?:varsa|yoksa|değilse)>`),
  // "if the switch fails", "once it happens again"
  re(String.raw`<(?:if|once|when|whenever) (?!you>)[^,.;?!\n]{1,60}?<(?:happens?|fails?|breaks?|occurs?|goes wrong|stops? working|(?:does|do)(?:n'?t| not)|comes? up|shows? up|appears?|recurs?|hits?|reaches|again)>`),
  // "after a few days of data", "can only be done later", "birkaç gün sonra"
  re(String.raw`<(?:after|in|within|for) (?:a few|a couple of|several|some|a|one|two|three|\d+) (?:more )?(?:days?|weeks?|months?)>`),
  re(String.raw`<(?:can|could) only be (?:done|made|run|compared|measured|checked|judged|evaluated|assessed)`),
  re(String.raw`<(?:birkaç|bir iki|\d+) (?:gün|hafta|ay)\p{L}*|<veri (?:birik|toplan)`),
]
// a heading of what was not verified: the heading and its lines up to the next blank line are a report, not a list
const NOT_VERIFIED = re(
  String.raw`^[\s#*_-]*(?:not (?:yet )?(?:verified|tested|checked)|unverified|untested|what (?:i )?(?:did not|didn'?t|could not|couldn'?t) (?:verify|test|check)|doğrulanma(?:yan|dı|mış)\p{L}*|doğrulayamadı\p{L}*|test edilme(?:yen|di|miş)\p{L}*|denenme(?:yen|di|miş)\p{L}*|kontrol edilme(?:yen|di|miş)\p{L}*)>[^\n]{0,40}?(?::|\*\*|$)`,
)

function isUserOnly(sentence: string) {
  const text = fold(prose(sentence))
  if (HEADING_CUE.test(text) || OFFER_CUES.some(offer => offer.test(text)) || isMenu(sentence)) return false
  if (LATER.some(marker => marker.test(text))) return true
  // work announced as not done stays against a mere "you can": "not implemented yet; you can use the old one"
  if (NOT_DONE_CUES.some(cue => cue.test(text))) return false
  if (ADDRESSED.some(marker => marker.test(text))) return true
  return OWN_CONDITIONAL.test(text) && !FIRST_PERSON.test(text)
}

// the message with the person's part taken out: what the cues and the judge read. Untouched lines stay as they are
export function assistantsPart(message: string) {
  const kept: string[] = []
  let isSkipping = false
  for (const line of message.split('\n')) {
    if (!line.trim()) {
      isSkipping = false
      kept.push(line)
      continue
    }
    if (isSkipping) continue
    if (NOT_VERIFIED.test(fold(line))) {
      isSkipping = true
      continue
    }
    const sentences = line.split(/(?<=[.!?])\s+/u)
    const left = sentences.filter(sentence => !isUserOnly(sentence))
    if (left.length === sentences.length) kept.push(line)
    else if (left.length) kept.push(left.join(' '))
  }
  return kept.join('\n')
}

// soft cues: words that often carry an offer or a next step in a phrasing the work cues don't know ("that's the first
// thing to add next", "it could support…"). They only send the message to the judge; without a judge they stop.
const SOFT_CUES = re(
  String.raw`<(?:next|later|afterwards|follow|further|future|also|could|might|would|improv|extend|missing|not yet|left|remain|sonra|ileride|ayrıca|eksik|geliştir|iyileştir|kaldı|kalan)`,
)

// isWork: a work cue (blocks even without the judge); isSoft: only a soft cue (the judge decides, else it stops)
// isMenu: a menu (a work cue of its own, with its own block reason)
export type FinishCues = { isWork: boolean; isAsk: boolean; isSoft: boolean; isMenu: boolean }

export function finishCues(message: string): FinishCues {
  const part = assistantsPart(message)
  const text = fold(prose(part)).replace(NOTHING_LEFT, ' ')
  const hasMenu = sentencesOf(part).some(isMenu)
  const isWork = hasMenu || WORK_CUES.some(cue => cue.test(text))
  // an ask is read in the whole message: a request to the person is theirs, and stays one; a menu sentence is none
  const isAsk = sentencesOf(fold(prose(message))).some(
    sentence => !isMenu(sentence) && ASK_TOPICS.some(topic => topic.test(sentence)) && REQUEST.test(sentence),
  )
  return { isWork, isAsk, isSoft: !isWork && SOFT_CUES.test(text), isMenu: hasMenu }
}

// the heuristic's verdict alone: true blocks the stop
export function heuristicBlocks(message: string) {
  const { isWork, isAsk } = finishCues(message)
  return isWork && !isAsk
}

export type StopInput = {
  stop_hook_active?: boolean
  last_assistant_message?: string
  background_tasks?: { status?: string }[]
  session_crons?: unknown[]
  agent_id?: string
}

// still to wake the loop: background work in flight or a cron of the session
export function isWaiting(e: StopInput) {
  const inFlight = Array.isArray(e.background_tasks) ? e.background_tasks : []
  const crons = Array.isArray(e.session_crons) ? e.session_crons : []
  return inFlight.some(task => task?.status !== 'completed' && task?.status !== 'failed' && task?.status !== 'killed') || crons.length > 0
}

// The guard's state and its parts, called from register.tsx's own handlers (an event takes one unmatched hook per
// module, and $ never crosses an import): finishPrompt from prompt.submit, finishTurnStart from turn.start,
// finishTurnComplete from turn.complete; classic.Stop asks finishCandidate, the judge, then finishVerdict.
let blocks = 0 // blocks since the person's last prompt
let isFailed = false // the main loop's last turn ended on an error or an interrupt
let isListAsked = false // the person's last prompt asked for a list of next steps or suggestions: it is the answer

// the person asking for the list itself ("list the follow-ups", "sonraki adımları öner", "just a plan")
const LIST_ASKED = [
  re(String.raw`<(?:list|suggest|recommend|propose|outline|write down|give me|end with)>[^.?!\n]{0,40}(?:next steps|follow[- ]?ups?|improvements|ideas|todos?|to ?do|what(?:'s| is) left|remaining|suggestions)`),
  re(String.raw`<(?:suggestions|recommendations|roadmap|plan only|just (?:a |the )?plan|(?:don'?t|do not) (?:implement|change|edit|write code))`),
  re(String.raw`<(?:sonraki adım|kalan|yapılacak|iyileştirme|öneri|fikir)\p{L}*>[^.?!\n]{0,40}(?:listele|sırala|yaz|öner|söyle|çıkar)`),
  re(String.raw`<(?:önerilerini|önerin ne|ne önerirsin|yol haritası|sadece plan|yalnızca plan|plan çıkar|kod yazma>|değiştirme>|dokunma>)`),
]

// a prompt of the person's (not a background task's notification) starts the count afresh, and says whether the
// list is what they asked for
export function finishPrompt(origin: string | undefined, text = '') {
  if (origin === 'task-notification') return
  blocks = 0
  const asked = fold(text)
  isListAsked = LIST_ASKED.some(cue => cue.test(asked))
}

export function finishTurnStart() {
  isFailed = false
}

export function finishTurnComplete(e: { agentId?: string; reason: string; isAborted: boolean }) {
  if (e.agentId === undefined) isFailed = e.reason === 'error' || e.reason === 'aborted' || e.isAborted
}

// the guard's mode from the environment: manager mode, the "does it itself" mode, or off
export function finishModeOf(manager: string | undefined, finish: string | undefined) {
  if (manager === '1') return 'manager' as const
  if (finish === '1') return 'solo' as const
  return undefined
}
export type FinishMode = NonNullable<ReturnType<typeof finishModeOf>>

// what the guard finds before any judge: undefined lets the stop stand
export function finishCandidate(mode: FinishMode | undefined, e: StopInput) {
  if (!mode || e.agent_id || isFailed || isListAsked || blocks >= FINISH_BLOCKS_MAX || isWaiting(e)) return undefined
  const message = typeof e.last_assistant_message === 'string' ? e.last_assistant_message : ''
  if (!message.trim()) return undefined
  const cues = finishCues(message)
  if (!cues.isWork && !cues.isSoft) return undefined
  return { mode, judged: assistantsPart(message).slice(-JUDGE_CHARS), cues }
}

// the verdict on a candidate: the judge's label decides; with none (judge off, failed, no label named) the
// heuristic does. Returns the block to add to the Stop answer (counted), or undefined to let the stop stand
export function finishVerdict(found: { mode: FinishMode; cues: FinishCues }, label: string | undefined) {
  // a menu with no real ask blocks whatever the judge says: it is the assistant's choice handed back
  const isMenu = found.cues.isMenu && !found.cues.isAsk
  const isBlocking = isMenu || (label === undefined ? found.cues.isWork && !found.cues.isAsk : label === JUDGE_LABELS[0])
  if (!isBlocking) return undefined
  blocks++
  if (isMenu) return { block: found.mode === 'manager' ? FINISH_REASON_MENU_MANAGER : FINISH_REASON_MENU_SOLO }
  return { block: found.mode === 'manager' ? FINISH_REASON_MANAGER : FINISH_REASON_SOLO }
}
