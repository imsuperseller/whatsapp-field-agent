// English customer regressions and fictional Hebrew demo cases, preserved from the integration test.
const MUST_ANSWER = [
  'Yo bobot',                                             // Alex.K addressed the assistant by its crew-given name
  "What's the fuse for the pats ring on a 2004 f250",    // Alex.K — clear request, no trailing question mark
  'What is the RKE add process for Toyota?',            // the first real crew question, answered well
  'I just need the metal key blank',                     // Sam — no question mark, dropped once before
  'What is the key blank for a 2020 ford escape',
  'Anyone have tips for lockouts on Toyotas?',
  '2015 Ford F-150 add a key',
  'my lishi keeps slipping on this door cylinder',
  'need the pin code procedure for a 19 4Runner thanks',   // ends in thanks, but it IS a request
  'Anyone know anything about ford expedition push start systems? My Tio’s car keeps dying',
  // A mention MID-message is still the speaker's own request — must never be dropped.
  "thanks @12145550001, so what's the fuse for the pats ring on a 2004 f250?",
  // Tagging the assistant itself is asking US — by phone or by the lid a real
  // WhatsApp mention actually carries.
  '@15555550100 what is the key blank for a 2020 ford escape?',
  '@100000000000002 what is the key blank for a 2020 ford escape?',
  // The new "answering a mate" and "short banter" rules must not eat a request.
  'No but I need the key blank for a 2020 Escape',
  'Any tips?',
  'Good morning guys, any idea on a 2019 Ram 1500 smart key?',
  'Hello everyone, is a 2021 Tahoe all keys lost doable on site?',
  'Hey guys why is my programmer not reading the 2018 Altima?',
  'What blank?',
  // Fictional demo: a situation followed by a real question is still a request.
  'Dispatch sent me to the wrong address, what do I do?',
  "A customer is verbally aggressive, what's the safety rule?",
  'Look up job #54321 for another technician',
  'מה ההבדל בין מנעול פינים למנעול וייפרים?',
  'המוקד שלח אותי לכתובת לא נכונה, מה עושים?',
  'לקוח רוצה לשלם חצי עכשיו וחצי אחר כך, זה מותר?',
  'אילו בלנקים נושאים לרכבים אירופאים מול אמריקאים?',
  'איך רושמים עבודה שהושלמה לצורך חיוב?',
  // The 2026-09-22 teaching and room-greeting rules must not eat a request.
  'Hey guys, need the pin code for a 2018 f150',
  'Morning all, anyone got the blank for a 2019 camry',
  'Good morning, what is the blank for a 2019 camry?',
  "Here's what I've got, 2019 camry smart key won't program, any idea",
  'How do I drill open a Schlage Everest?',
];
const MUST_IGNORE = [
  'תודה רבה',
  'מצחיק היום?',
  '@100000000000001 מה עושים עכשיו?',
  'Yo Alex',                                               // greeting another member is still room conversation
  '@all he got it right 👍',                             // the praise it replied to, 2026-08-28
  'Yes sir',
  'Ok',
  'oh',
  '@all remember to clock out before you leave',
  'nice work today everyone',
  // 2026-08-29: he was closing the thread, and it answered him again.
  'I’ll see if he can, I’m assuming some module or something is staying stuck on, kinda trying to troubleshoot from 800 miles away, thank you',
  'appreciate it',
  // 2026-08-29: one technician helping another, and it answered him.
  "Ford's do very weird stuff when the alts start to go so he may be onto something there. They also like to kill the fuel pump module so that's on the list as well",
  // 2026-08-31: Sam tagged Alex.K to ask HIM whether the answer was right, and
  // the assistant answered instead. A tagged member is who the question is for.
  '@100000000000001 was this the right answer?',
  '@100000000000001 can you cover the Plano job tonight?',
  // 2026-08-31, while the crew discussed one of Bobot's own answers. Both of
  // these were answered live with "I don't know this yet, want me to look
  // online?" — in front of sixteen people, to men who asked it nothing.
  "No but the answer varies but it's typically either one of the first ones or one in the middle. Sometimes it's a five sometimes it's a 20. To be fair, I did ask it a difficult question intentionally.",
  'Tricky for new people? 😰',
  '@100000000000001 wrong address, what do I do?',
  'Ford intentionally does not label their fuse boxes in order to try to obfuscate what the with the correct answer might be, so this is tricky especially for new people',
  // 2026-09-22: Jordan answering Alex, at Sam's request. Bobot cut in with a video.
  'Heres how you drill a schlage everest cylinder, you drill the top sheer line  just like you would a regular cylinder, once all top pins have been drilled and cleared, you use a blank schlage everest key matching the current keyway to bypass the secondary bottom security pin, then turn to unlock',
  'You have to pull the exterior handle and  unlock toggle at the same time',
  // 2026-09-19 and 2026-09-03: office notices to the room, both answered.
  'Good morning Gentlemen I will need all jobs closed by 10pm so I can run an early report, if jobs are not closed they will go on next weeks report. Thank You have a nice day....Windy',
  'Hello Everyone… any new picture you all can share with me??? Thank you', // Monika 2026-10-05 — Bobot offered a web search
  'Hiii all, please send new pictures. Car keys, fobs, deadbolts, smart locks, commercial locksmith jobs etc.. thank you 🙏',
];
module.exports = { MUST_ANSWER, MUST_IGNORE };
