const test = require('node:test');
const assert = require('node:assert/strict');
const { decideReply, decideFollowup } = require('../reply-decision.cjs');
const { MUST_ANSWER, MUST_IGNORE } = require('./reply-corpus.cjs');
const ourIds = ['15555550100', '100000000000002'];

test('real English and fictional Hebrew corpus runs without replacing network or file functions', () => {
  for (const text of MUST_ANSWER) assert.equal(decideReply({ text, ourIds }).action, 'ask', text);
  for (const text of MUST_IGNORE) assert.equal(decideReply({ text, ourIds }).action, 'ignore', text);
});

test('a picture is answered only when it asks something or addresses Bobot', () => {
  // 2026-10-05: 28 job photos posted on request drew 27 replies in the live group.
  for (const text of ['', 'ok', '@all check this out', 'Done', 'Job from today']) assert.equal(decideReply({ text, hasMedia: true, ourIds }).action, 'ignore', text);
  for (const text of ['what is this?', 'Bobot', 'bobot what lock is this', '@15555550100', 'which blank fits this', 'need the code for this one']) assert.equal(decideReply({ text, hasMedia: true, ourIds }).action, 'ask', text);
  assert.equal(decideReply({ text: '' }).action, 'ignore');
});

test('addressing Bobot removes only the leading invocation', () => {
  assert.equal(decideReply({ text: 'Yo bobot, what blank?', ourIds }).question, 'what blank?');
  assert.equal(decideReply({ text: 'Yo bobot', ourIds }).question, 'Yo bobot');
});

test('yes and no use the pending question and preserve provisional evidence', () => {
  for (const [kind, yes, no] of [['permission', 'search_online', 'send_to_owner'], ['feedback', 'confirm_worked', 'reject_answer']]) {
    const pending = { kind, question: 'Original question', provisionalAnswer: 'Provisional answer' };
    assert.deepEqual(decideFollowup('yes', pending), { question: pending.question, action: yes, provisionalAnswer: pending.provisionalAnswer });
    assert.equal(decideFollowup('no', pending).action, no);
  }
  assert.equal(decideFollowup('yes', null), null);
  assert.equal(decideFollowup('new question', { kind: 'permission' }), null);
});
