'use strict';
// Pure reply policy; no network, files, credentials, or clock reads.

function followupDecision(text) {
  const cleaned = String(text || '').trim();
  if (/^(?:(?:hey|yo|hi)[,\s]+)?bobot[,\s]+(?:yes|yeah|yep|sure|go ahead|search|look it up)(?:\s+please)?[.!]?$/i.test(cleaned)
      || /^(?:yes|yeah|yep|sure|go ahead|search|look it up)(?:\s+please)?[.!]?$/i.test(cleaned)) return 'yes';
  if (/^(?:(?:hey|yo|hi)[,\s]+)?bobot[,\s]+(?:no|nope|send it to sam|ask sam)[.!]?$/i.test(cleaned)
      || /^(?:no|nope|send it to sam|ask sam)[.!]?$/i.test(cleaned)) return 'no';
  return null;
}

function questionForBrain(text) {
  const original = String(text || '').trim();
  const withoutName = original.replace(
    /^(?:(?:hey|yo|hi|hello)[,\s]+)?bobot\b[,\s:—-]*/i,
    '',
  ).trim();
  return withoutName || original;
}

function decideReply({ text = '', hasMedia = false, ourIds = [] }) {
  const imagePart = hasMedia;
  if (!imagePart && text.length < 2) return { action: 'ignore', result: 'nothing to answer', verdict: 'nothing to answer — empty message, no media' };
  const ACK = /^\s*(?:ok(?:ay)?|yes(?: sir)?|no|thanks?|thank you|got it|heard|copy|confirmed|sounds good|perfect|k|yep|yeah|nope|sure|will do|on it|oh|lol|haha|nice|👍|🫡|💯)\b[\s.!?]*$/i;
  const looksLikeAnswerToSomeoneElse = text.length < 60 && !/\?/.test(text)
    && /^\s*(?:[a-z]{1,3}\d{2,}|it'?s |that'?s |try |use |pull |i had |i think|i believe)/i.test(text);
  // A message TO THE ROOM, not to us. Added 2026-08-28, an hour after the first
  // real technician question was answered well: he then told the group "@all he
  // got it right 👍" and the assistant replied "Glad it worked out!". Nobody
  // asked it anything. That is precisely how an assistant gets muted in a
  // working group — Sam's own reason for wanting it to answer questions only.
  //
  // The test is deliberately conservative, because the opposite mistake has
  // already been made here: Sam wrote "I just need the metal key blank" — no
  // question mark — and an over-narrow rule dropped it in silence. So a message
  // is left alone only when it asks nothing AND is either addressed to the room
  // or too short to carry a request about the work.
  const TRADE_WORD = /\b(key|keys|fob|remote|transponder|immo|program|blank|cut|code|ignition|cylinder|lishi|obd|lockout|wafer|deadbolt|rekey|vin|akl|smart ?key|door lock)\b|מנעול|מפתח|מפתחות|בלנק|צילינדר|כספת|קומבינציה/i;
  const toTheRoom = /@all\b|@everyone\b/i.test(text);
  const noQuestion = !/\?/.test(text);
  // The crew named the assistant Bobot. On 2026-08-29 Alex.K wrote "Yo bobot"
  // and then "What's the fuse for the pats ring on a 2004 f250". Both were
  // dropped: the greeting looked like room chatter, and the request had no
  // trailing question mark and used trade words absent from TRADE_WORD.
  //
  // A direct invocation and a plain request opener are stronger evidence than a
  // short-message heuristic. Keep this semantic rather than adding every new
  // locksmith noun to TRADE_WORD — the next missing noun would recreate the bug.
  // TAGGING US IS ASKING US, whether or not the crew types the name. The ids come
  // from the gateway (phone AND lid) because a mention carries the lid.
  const us = ourIds;
  const tagsUs = us.length > 0 && new RegExp(`@(?:${us.join('|')})\\b`).test(text);
  const directlyAddressesUs = tagsUs || /^\s*(?:(?:hey|yo|hi|hello)[,\s]+)?bobot\b/i.test(text);

  // A QUESTION AIMED AT ONE PERSON BY NAME. 2026-08-31: Sam tagged Alex.K —
  // "@100000000000001 was this the right answer?" — and Bobot answered him.
  // Only @all/@everyone counted as "said to the room", so tagging ONE member
  // was invisible here, and the question mark made a question asked of Alex
  // look like a question asked of us.
  //
  // A man who names who he is talking to has addressed somebody, and that is
  // stronger evidence than any heuristic below. Kept deliberately narrow,
  // because a dropped request is worse than a stray reply: the mention must
  // OPEN the message, must not be @all/@everyone, and the message must not also
  // be aimed at us. "thanks @alex, what's the fuse for an 04 f250" is still a
  // request, still answered.
  const openingMention = text.match(/^\s*@(\w+)/);
  const addressesSomeoneElse = Boolean(openingMention)
    && !/^(?:all|everyone)$/i.test(openingMention[1])
    && !directlyAddressesUs;

  // ANSWERING A MATE AT LENGTH. 2026-08-31, while the crew was discussing one of
  // Bobot's own answers: "No but the answer varies but it's typically either one
  // of the first ones or one in the middle… To be fair, I did ask it a difficult
  // question intentionally." That is a man replying to Sam. It was long enough
  // to clear the short-message rule, said "I", and asked nothing — so nothing
  // caught it, and Bobot cut in with "I don't know this yet".
  //
  // The tell is the opener: a message that BEGINS by answering is a reply, not a
  // request. A trade word overrides it — "No but I need the key blank for a 2020
  // Escape" is a request, and dropping that would be the worse mistake.
  const ANSWER_OPENER = /^\s*(?:no\b|nope\b|yes\b|yeah\b|yep\b|not really\b|correct\b|exactly\b|true\b|depends\b|it depends\b|kinda\b|sort of\b|maybe\b)/i;
  const answeringAMate = ANSWER_OPENER.test(text) && !/\?/.test(text) && !TRADE_WORD.test(text);

  // BANTER THAT HAPPENS TO END IN A QUESTION MARK. Minutes later, another
  // technician wrote "Tricky for new people? 😰" — a remark to the man before
  // him. One question mark cleared every guard, and Bobot offered to search the
  // web for it in front of the whole crew.
  //
  // Short, no trade word, no request opener: nobody is asking us for anything.
  // "Any tips?" survives on its opener, "What blank?" on its trade word.
  // A greeting to the room is not part of the question: "Hey guys why is my
  // programmer not reading the 2018 Altima?" was dropped as short banter because
  // its opener came after "Hey guys" with no comma (found 2026-10-05).
  const afterGreeting = text.replace(/^\s*(?:(?:good\s+(?:morning|afternoon|evening|night)|morning|evening|hi+|hey+|hello|yo)[,!\s]+)?(?:all|everyone|everybody|gentlemen|gents|guys|team|fellas|y'?all|crew)\b[,!\s]*/i, '');
  const asksForHelp = /(?:^|[,;])\s*(?:who|what(?:'s| is| are)?|which|where|when|why|how|can|could|would|do|does|did|is|are|should|anyone|anybody|need|looking for|look up|any tips|any idea)\b/i.test(text)
    // Hebrew questions may follow the situation, and JS \b is ASCII-only.
    || /(?:^|[\s,])(?:מה|איך|האם|כמה|מתי|איפה|היכן|למה|מדוע|איזה|איזו|אילו|אפשר)(?=\s|[?!,.:]|$)/u.test(text)
    || /(?:^|[\s,])זה\s+מותר\s*\?/u.test(text)
    || /(?:^|[,;])\s*(?:who|what(?:'s| is| are)?|which|where|when|why|how|can|could|would|do|does|did|is|are|should|anyone|anybody|need|looking for|look up|any tips|any idea)\b/i.test(afterGreeting);
  // A SIGN-OFF. 2026-08-29: a technician working through his uncle's Expedition
  // wrote "…kinda trying to troubleshoot from 800 miles away, thank you" — he was
  // closing the thread, and the assistant answered him again. Long enough to
  // dodge the short-message rule, no @all, so nothing caught it.
  //
  // Ending in thanks only counts as closing when the message ALSO says nothing
  // about the work: technicians really do write "need the pin code procedure for
  // a 19 4Runner thanks", and that is a request, not a goodbye.
  const signsOff = /\b(thank you|thanks|thx|ty|appreciate it|much appreciated)\b[\s.!👍🙏]*$/i.test(text);

  // ONE TECHNICIAN ANSWERING ANOTHER. 2026-08-29: "Ford's do very weird stuff
  // when the alts start to go so he may be onto something there. They also like
  // to kill the fuel pump module…" — that is a man helping his mate, and the
  // assistant answered it. Long enough to clear the short-message rule, no
  // question mark, no sign-off, so nothing caught it.
  //
  // The tell is that it talks ABOUT somebody in the third person and asks
  // nothing for the speaker himself. A message with "my", "I need", "I have" or
  // an opener like "anyone" or "how do" is the speaker's own problem and is
  // always answered — that is the side of this line that must never be got
  // wrong, because a dropped request is worse than a stray reply.
  const aboutSomeoneElse = /\b(he|she|they|him|her|them|his|their)\b/i.test(text);
  const speakingForHimself = /\b(i|i'?m|im|my|mine|me)\b|\b(anyone|anybody|does anyone|how do|what is|what'?s|which|need|looking for|any tips|any idea)\b/i.test(text);
  const helpingAMate = aboutSomeoneElse && !speakingForHimself;

  const shortBanter = text.length < 60 && !TRADE_WORD.test(text);

  // TEACHING A MATE. 2026-09-22: Sam asked Jordan to tell Alex how to drill a
  // Schlage Everest. Jordan wrote "Heres how you drill a schlage everest
  // cylinder, you drill the top sheer line…" — the answer, in the second
  // person, asking nothing. No pronoun about a third person, no sign-off, and a
  // trade word, so every rule above let it through; Bobot cut in over the
  // man's answer with an unrelated video. A message that opens by explaining
  // how is an answer, not a request.
  const teachesAMate = /^\s*(?:here'?s|heres|here is|this is|that'?s|thats) how\b/i.test(text)
    || /^\s*(?:you|u|ya) (?:have to|need to|gotta|got to|just|want to|wanna|drill|use|pull|pick|cut|bypass)\b/i.test(text);

  // AN OFFICE NOTICE TO THE ROOM. 2026-09-19 Windy wrote "Good morning
  // Gentlemen I will need all jobs closed by 10pm…" and 2026-09-03 Monika wrote
  // "Hiii all, please send new pictures…". Bobot answered both, and to Windy it
  // invented a check-out procedure. A greeting to the whole room that asks
  // nothing is management talking, not a technician asking. "Hey guys, need the
  // pin for a 2018 f150" still passes: its request opener sets asksForHelp.
  const greetsTheRoom = /^\s*(?:(?:good\s+(?:morning|afternoon|evening|night)|morning|evening|hi+|hey+|hello|yo)[,!\s]+)?(?:all|everyone|everybody|gentlemen|gents|guys|team|fellas|y'?all|crew)\b/i.test(text)
    || /^\s*good\s+(?:morning|afternoon|evening|night)\b/i.test(text);

  // THE SAME NOTICE, WITH A QUESTION MARK. 2026-10-05 Monika wrote "Hello
  // Everyone… any new picture you all can share with me??? Thank you" and Bobot
  // offered to search the web for it. The 09-19 rule above only covered notices
  // that ask nothing; this one asks the crew, not us. A greeting to the room with
  // no trade word and no help-seeking words is the office asking the people.
  // "Good morning guys, any idea on a 2019 Ram?" still passes on "any idea".
  const asksTheCrewNotUs = greetsTheRoom && !TRADE_WORD.test(text)
    && !/\b(?:anyone|anybody|any ?idea|any tips|how (?:do|to|can|would)|what(?:'s| is| are)?|which|where|why|need|looking for|help|stuck)\b/i.test(text);
  const talkingAboutUs = !directlyAddressesUs && !asksForHelp && (
    shortBanter
    || answeringAMate
    || (noQuestion && (
      toTheRoom
      || (signsOff && !TRADE_WORD.test(text))
      || helpingAMate
      || greetsTheRoom
    ))
    || asksTheCrewNotUs
  ) || (!directlyAddressesUs && noQuestion && teachesAMate);
  // A PHOTO IS NOT A QUESTION BY ITSELF. 2026-10-05 22:19 UTC: Monika had asked
  // the crew for job photos, two technicians posted 28, and Bobot described
  // every one in the live group — 27 replies in two bursts. In a group, media is
  // answered only when its caption asks something or the sender addresses Bobot
  // ("Bobot what lock is this", a tag, "what is this?").
  if (imagePart && !directlyAddressesUs && !asksForHelp && !/\?/.test(text)) {
    return { action: 'ignore', result: 'left alone - a picture with no question', verdict: 'left alone - picture with no question to us' };
  }
  if (!imagePart && (ACK.test(text) || looksLikeAnswerToSomeoneElse || talkingAboutUs || addressesSomeoneElse)) {
    return {
      action: 'ignore',
      result: 'left alone - not a question to us',
      verdict: addressesSomeoneElse
        ? 'left alone - tagged another member, not us'
        : talkingAboutUs && !ACK.test(text)
          ? 'left alone - said to the room, not asked of us'
          : 'left alone - not a question to us',
    };
  }
  return { action: 'ask', question: questionForBrain(text) };
}

// THE OWNER TEACHING FROM THE GROUP. 2026-09-22: Bobot could not answer how to
// drill a Schlage Everest, Sam asked Jordan, Jordan answered in the group, and
// Sam wrote "@Bobot log Jordan's answer as the answer to alexs question". Bobot
// refused — the only way to teach it was the dashboard queue. The owner's word
// in his own group is the approval; the brain still checks he IS the owner.
//
// Recognised only when the message is aimed at us AND asks to keep an answer:
//   "@Bobot log Jordan's answer as the answer to alexs question"
//   "bobot save this" (as a WhatsApp reply to the answer)
function teachCommand({ text = '', ourIds = [], quoted = '' }) {
  const t = String(text || '').trim();
  const tagsUs = ourIds.length > 0 && new RegExp(`@(?:${ourIds.join('|')})\\b`).test(t);
  const namesUs = /^\s*(?:(?:hey|yo|hi|hello)[,\s]+)?bobot\b/i.test(t);
  if (!tagsUs && !namesUs) return null;
  if (!/\b(?:log|save|record|remember|store|learn|teach|add|use|keep)\b/i.test(t)) return null;
  const hasQuote = Boolean(String(quoted || '').trim());
  const answerBy = (t.match(/\b([a-z][\w.]*?)['’]?s\s+answer\b/i) || t.match(/\banswer\s+(?:from|by)\s+([a-z][\w.]*)/i) || [])[1] || null;
  const questionBy = (t.match(/\b(?:to|for)\s+([a-z][\w.]*?)['’]?s?\s+question\b/i) || [])[1] || null;
  const mentionsAnswer = /\banswer\b|\bthis\b|\bthat\b/i.test(t);
  if (!answerBy && !hasQuote) return null;
  if (!mentionsAnswer) return null;
  return { answerBy, questionBy, useQuoted: hasQuote };
}

function nameMatches(pushName, token) {
  if (!pushName || !token) return false;
  const words = String(pushName).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  const raw = String(token).toLowerCase().replace(/[^a-z]/g, '');
  const variants = [raw, raw.replace(/s$/, '')].filter((v) => v.length >= 3);
  return words.some((w) => variants.some((v) => w === v || (w.length >= 3 && (w.startsWith(v) || v.startsWith(w)))));
}

// Picks the answer and the question out of the last few hours of the group.
// `recent` is oldest-first: { at (ms), name, text, asked (the question sent to
// the brain, or null) }. Returns null parts rather than guessing.
function resolveTeach(cmd, recent, { quoted = '', now = Date.now(), windowMs = 6 * 60 * 60 * 1000 } = {}) {
  const fresh = (recent || []).filter((m) => m && now - Number(m.at) <= windowMs).reverse();
  let answer = String(quoted || '').trim() || null;
  if (!answer && cmd.answerBy) {
    const hit = fresh.find((m) => nameMatches(m.name, cmd.answerBy) && String(m.text || '').trim().length >= 15 && !m.asked);
    answer = hit ? String(hit.text).trim() : null;
  }
  const asked = fresh.filter((m) => m.asked);
  const q = cmd.questionBy ? asked.find((m) => nameMatches(m.name, cmd.questionBy)) : asked[0];
  return { answer, question: q ? String(q.asked).trim() : null };
}

// A PRIVATE CHAT WITH BOBOT (2026-09-23). Sam approved technicians, himself
// and the office messaging Bobot one-to-one on the same number. Nobody else is
// in that chat, so every message in it is said to Bobot: none of the room rules
// in decideReply apply ("@all", a mate being answered, an office notice). The
// one thing still left alone is a pure acknowledgement — "ok", "thanks",
// "👍" — because answering a thank-you is how an assistant gets muted.
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f]/gu;
const ACK_WORD = '(?:ok(?:ay)?|k|kk|yes(?: sir)?|yep|yeah|yup|no|nope|sure|thanks?|thank you(?: (?:so|very) much)?|thx|ty|tysm|appreciate it|much appreciated|got it|gotcha|heard|copy(?: that)?|roger(?: that)?|confirmed|sounds good|perfect|great|cool|awesome|nice|will do|on it|lol|haha|תודה(?: רבה)?|סבבה|אוקיי?)';
const PRIVATE_ACK = new RegExp(`^${ACK_WORD}(?:[\\s,.!]+${ACK_WORD})*[\\s.!]*$`, 'i');

function isAcknowledgement(text) {
  const words = String(text || '').replace(EMOJI, ' ').replace(/\s+/g, ' ').trim();
  // Nothing but emoji: a thumbs-up, a salute, a thank-you hand.
  if (!words && String(text || '').trim()) return true;
  // The name alone ("bobot", "yo bobot") is a summons, not an acknowledgement.
  const withoutName = words.replace(/\bbobot\b/gi, ' ').replace(/[\s,.!]+/g, ' ').trim();
  if (!withoutName) return false;
  return PRIVATE_ACK.test(withoutName);
}

function decidePrivateReply({ text = '', hasMedia = false }) {
  if (!hasMedia && isAcknowledgement(text)) {
    return { action: 'ignore', result: 'left alone - acknowledgement', verdict: 'left alone - acknowledgement in a private chat' };
  }
  if (!hasMedia && text.length < 2) return { action: 'ignore', result: 'nothing to answer', verdict: 'nothing to answer — empty message, no media' };
  return { action: 'ask', question: questionForBrain(text) };
}

function decideFollowup(text, pending) {
  const decision = followupDecision(text);
  if (!decision || !pending) return null;
  return {
    question: pending.question,
    action: pending.kind === 'permission'
      ? (decision === 'yes' ? 'search_online' : 'send_to_owner')
      : (decision === 'yes' ? 'confirm_worked' : 'reject_answer'),
    ...(pending.provisionalAnswer ? { provisionalAnswer: pending.provisionalAnswer } : {}),
  };
}
module.exports = { decideReply, decidePrivateReply, isAcknowledgement, decideFollowup, followupDecision, questionForBrain, teachCommand, resolveTeach, nameMatches };
