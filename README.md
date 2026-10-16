# Bobot — a WhatsApp field-support agent gateway

Bobot answers technicians' questions inside a small business's WhatsApp group. A technician on a job asks "what key blank fits a 2020 Ford Escape?", sends a photo of a lock, records a voice note or shoots a short video, and Bobot replies in the group. It runs in production for a 23-technician field-service crew.

This repository is the **gateway**: the part that sits next to the WhatsApp connection, decides whether a message is meant for the agent at all, turns photos, voice notes and videos into something a language model can read, and sends the reply. The answering "brain" (a tenant-scoped LLM service with the company's knowledge) is a separate private service, and this gateway calls it over HTTPS.

Customer names, phone numbers and server details have been replaced with placeholders. The logic and tests are unchanged.

## The hard part: knowing when to stay quiet

A bot in a busy group chat fails mostly by talking too much. `reply-decision.cjs` is a pure function (no network, no clock) that sorts every message into "answer", "leave alone" or "follow-up", and each rule came from a real production incident:

- Acknowledgements ("ok", "copy", 👍) and messages addressed to the room ("@all he got it right") get no reply.
- A short line that looks like one technician answering another ("it's a B111") is left alone.
- A plain "yes" or "no" right after the agent asked something is read as the answer to that question.
- The owner can teach it: "@Bobot log Jordan's answer as the answer to Alex's question" stores a correction.
- A burst guard caps any group at three agent posts in two minutes. Extra replies are held and logged, never sent. It was added after 28 job photos once drew 27 replies.

`test/reply-corpus.cjs` keeps real phrasings, including Hebrew ones, as regression cases.

## Photos, voice notes and video

`media.cjs` uses `ffmpeg` on the server:

- **Photo:** sent to the brain as bytes, with the caption as the question.
- **Voice note:** converted to a mono MP3 (at most 3 minutes) and transcribed. The words are then judged like a typed message, so "on my way" is still ignored.
- **Video:** reduced to one JPEG of three stills plus a transcript of its audio, then answered through the ordinary photo path.
- A bare photo or video shared with the room draws no reply. Nothing is fetched or transcribed for a group that is set to listen only.

## Safety and cost

- **The customer pays for their own AI.** Every paid model call uses the customer's own API keys, and transcription has a daily cap per customer. Calls fail closed: there is no fallback to the platform's keys.
- **Access control:** private chats are answered only for current members of an authorized group. The member list is read live and trusted for one minute. If it can't be read, nobody is admitted.
- **Privacy-minded logs:** delivery logs keep a one-way digest of message IDs and no text, names or numbers. Text is kept only for messages the agent treated as questions, so a wrong answer can be traced. Logs rotate after 30 days.

## Operations

- `watchdog.js` proves on a timer that a message still completes the full WhatsApp round trip.
- `daily-announcer.js` posts the crew's morning and evening messages in the crew's own time zone, with configurable days off.
- `deploy/install.sh` backs up the running files, installs the new ones, syntax-checks them and restarts the service. It rolls back automatically if the end-to-end probe (`probe/`) fails.
- `systemd/` holds the service and timer units.

## Run the tests

Plain Node, no dependencies; `ffmpeg` is needed for the media tests.

```bash
npm test
```

## How it was built

I designed the system and its rules, and built it by directing AI coding agents (Claude Code) with tests as the contract. Each production incident became a rule and a regression test.
