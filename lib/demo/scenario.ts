// The demo's cards and what happens to them, as data: one morning on a head, from each connector in morkeleb/pbcp
// (caldav, goalpath, hermes, imap, n8n, obsidian-daily, todoist), shaped as those connectors make them. Pure: two
// runners play it. `pnpm demo` (scripts/demo.ts) sends it to a real head over HTTP; the front door (lib/demo/replay.ts)
// replays it in memory through @pbcp/core and shows the brief it makes, storing nothing.
//
// Every card's id has the namespace `demo` (`goalpath:demo:…`), and every order says DEMO_MARK in its body, so
// `pnpm demo --remove` and `pnpm demo:purge` can find them. `at` is the local time the step happens, for a runner that
// keeps time (the replay); the HTTP runner sends each step when it gets to it.

import type { ProducerCard } from '@pbcp/core';
import { addDays } from '../time';
import { DEMO_MARK, type DemoRoot } from './data';

/** A card as a demo producer sends it, without what every card carries (protocol, producer, to_person, emitted_at). */
export type DemoCard = { id: string; kind: ProducerCard['kind']; title: string; body: string } & Record<string, unknown>;

export type DemoStep =
  | { at: string; put: DemoRoot; card: DemoCard }
  /** The owner decides a card. */
  | { at: string; decide: string; decision: string }
  /**
   * The owner gives an order (Appendix A) and an executor works it: claims it, posts its progress (log signals in the
   * order's thread), and with `done` its outcome. Without `done` it is still in progress.
   */
  | { at: string; order: { to: DemoRoot; title: string; body: string }; work: { root: DemoRoot; at: string; steps: string[]; done?: { at: string; title: string; body: string } } };

const day = (d: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));

function isoWeek(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
}

const mailBody = (from: string, date: string, quote: string) => `- **From:** ${from}\n- **Date:** ${date}\n\n${quote.split('\n').map((l) => `> ${l}`).join('\n')}`;

/** The morning of `today` (YYYY-MM-DD, the head's local date). */
export function demoScenario(today: string): DemoStep[] {
  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);
  const friday = addDays(today, 3);
  const milestone = '7a1e0c2e-4d4b-4c51-9b1a-000000000004';
  return [
    // --- obsidian-daily: yesterday's note (log: in the day view, not the brief) -----------------------------------
    { at: '06:02', put: 'obsidian', card: {
      id: `obsidian:demo:${yesterday}`, kind: 'artifact', urgency: 'log', thread: `${yesterday.slice(0, 4)}-W${String(isoWeek(yesterday)).padStart(2, '0')}`,
      title: `Daily note ${yesterday}`,
      body: '## Done\n\n- Reviewed the billing forecast with Sara\n- Sketched the brief layout for the phone\n\n## Notes\n\nThe offsite is on the 14th; Jonas is booking. Ask about the train.\n\n## Tomorrow\n\n- [ ] Accept or reject GP-12\n- [ ] Reply to Anna',
    } },

    // --- caldav: the morning agenda (a table and a gantt), and an event that moved -------------------------------
    // `about` (§4.1) places each on its day (§8), whenever it is sent; `calendar` labels them for the filter.
    { at: '06:15', put: 'cal', card: {
      id: `cal:demo:${today}`, kind: 'artifact', urgency: 'brief', thread: `day-${today}`, about: today, labels: ['calendar'],
      title: `${day(today)}: 4 events, first at 09:15`,
      body: [
        '| Time | Event | Where |', '| --- | --- | --- |',
        '| all day | Office closed for the afternoon |  |',
        '| 09:15–09:30 | Standup |  |',
        '| 11:00–12:00 | Q4 review: budget and plan | Room 3, 2nd floor |',
        '| 14:00–14:45 | Dentist | Nørrebrogade 12 |',
        '| 16:30–17:00 | Call with Anna | Video |',
        '', '```mermaid', 'gantt', `  title ${day(today)}`, '  dateFormat HH:mm', '  axisFormat %H:%M',
        '  Standup :09:15, 09:30', '  Q4 review budget and plan :11:00, 12:00', '  Dentist :14:00, 14:45', '  Anna re invoice timing :16:30, 17:00', '```',
      ].join('\n'),
    } },
    // Tomorrow's agenda, sent today: its day is tomorrow (§8), so it is in Tomorrow, not today.
    { at: '06:16', put: 'cal', card: {
      id: `cal:demo:${tomorrow}`, kind: 'artifact', urgency: 'brief', thread: `day-${tomorrow}`, about: tomorrow, labels: ['calendar'],
      title: `${day(tomorrow)}: 2 events, first at 10:00`,
      summary: 'Design review at 10:00 and the offsite planning call at 14:00.',
      body: '| Time | Event |\n| --- | --- |\n| 10:00 | Design review |\n| 14:00 | Offsite planning |',
    } },

    // --- goalpath: a milestone that slipped (superseding its on-track card), an approval, a red build, the digest ---
    { at: '06:30', put: 'goalpath', card: {
      id: `goalpath:demo:digest-${yesterday}`, kind: 'artifact', urgency: 'brief', thread: 'p-demo', labels: ['billing-revamp', 'mobile-beta', 'rollout'],
      title: `GoalPath ${day(yesterday)}: 1 done, 1 blocked, 2 milestones late`,
      body: [
        '```mermaid', 'gantt', '  title Milestone forecasts', '  dateFormat YYYY-MM-DD', '  axisFormat %d %b',
        '  Billing revamp :crit, 2026-09-28, 2026-11-24', '  Mobile beta :2026-10-12, 2026-12-04', '  Rollout :crit, 2026-12-01, 2027-01-22', '```', '',
        '**Done** (accepted in the last 24 hours)', '- GP-10 Invoice PDF layout', '',
        '**Blocked**', '- GP-14 Retry failed card payments', '',
        '**Unplanned work.** 25% of completed work last week; the weeks before, newest first: 40%, 20%, 10%.',
      ].join('\n'),
    } },
    { at: '06:31', put: 'goalpath', card: {
      id: `goalpath:demo:${milestone}.20261112:on-track`, kind: 'signal', urgency: 'brief', thread: milestone, labels: ['billing-revamp'],
      source: { url: 'https://goalpath.example/m/4', label: 'GoalPath milestone' },
      title: 'Billing revamp: on track, forecast 12 Nov (deadline 13 Nov)',
      body: 'The forecast is 2026-11-12, on or before the deadline 2026-11-13.',
    } },
    { at: '06:52', put: 'goalpath', card: {
      id: `goalpath:demo:${milestone}.20261124:risk`, kind: 'signal', urgency: 'brief', thread: milestone, labels: ['billing-revamp'], supersedes: `goalpath:demo:${milestone}.20261112:on-track`,
      source: { url: 'https://goalpath.example/m/4', label: 'GoalPath milestone' },
      title: 'Billing revamp: forecast 24 Nov, 11 days past 13 Nov',
      body: [
        'Forecast **2026-11-24** (confidence: low) against the deadline 2026-11-13: 11 days late.', '',
        '**What moved.** The forecast was 2026-11-12 when last reported.',
        '- Scope grew by 6 items since 12 Oct', '- Velocity 18 points/week, down from 24', '',
        '**Also affected.** Rollout depends on this milestone.', '',
        '**Options**',
        '- Cut scope: move items out of Billing revamp until the forecast meets 2026-11-13.',
        '- Move the deadline to 2026-11-24 and re-plan what depends on it.',
        '- Add capacity to the milestone.',
      ].join('\n'),
    } },
    { at: '07:05', put: 'goalpath', card: {
      id: 'goalpath:demo:approval-3c9b7f10', kind: 'decision', urgency: 'brief', thread: milestone, labels: ['billing-revamp'],
      source: { url: 'https://goalpath.example/i/12', label: 'GoalPath item' },
      title: 'Accept GP-12 Export invoices as CSV?',
      summary: 'GP-12 is finished and waiting for you; accepting or rejecting sets it in GoalPath.',
      body: '**GP-12 Export invoices as CSV** is Finished and waiting for your acceptance.\n\n- Milestone: Billing revamp\n\n## Proposal\n\nAccept GP-12. Accepting or rejecting here sets its status in GoalPath.',
      actions: [{ id: 'accept', label: 'Accept', body: 'Sets GP-12 to Accepted.' }, { id: 'reject', label: 'Reject', body: 'Sets GP-12 to Rejected.' }],
    } },
    { at: '07:12', put: 'goalpath', card: {
      id: 'goalpath:demo:build-gh-run-118842', kind: 'signal', urgency: 'immediate', thread: milestone, labels: ['billing-revamp', 'ci'],
      source: { url: 'https://git.example/acme/billing/actions/runs/118842', label: 'Build run' },
      title: 'Build failed: ci / test on #91 (GP-14)',
      body: '**ci / test** ended `failure` on [#91](https://git.example/acme/billing/pull/91) Retry declined cards twice, linked to **GP-14 Retry failed card payments** in Billing revamp.',
    } },

    // --- imap: two unread messages in one thread (decisions), one from another folder (artifact), a newsletter -----
    { at: '07:20', put: 'mail', card: {
      id: 'mail:demo:9f86d081884c7d659a2feaa0', kind: 'artifact', title: 'Your October statement is ready',
      body: mailBody('Bank <no-reply@bank.example>', `${today}T05:02:00.000Z`, 'Your statement for October 2026 is available in online banking.'),
    } },
    { at: '07:21', put: 'mail', card: {
      id: 'mail:demo:b1946ac92492d2347c6235b4', kind: 'decision', actions: ['archive', 'keep'], title: 'Newsletter: 10 tips for better standups',
      body: mailBody('Team Weekly <news@weekly.example>', `${yesterday}T16:20:00.000Z`, 'This week: ten tips for standups people actually like.'),
    } },
    { at: '07:42', put: 'mail', card: {
      id: 'mail:demo:5d41402abc4b2a76b9719d91', kind: 'decision', thread: 'thr-1781234567890123456', actions: ['archive', 'keep'],
      title: 'Offsite on the 14th: are you in?',
      summary: 'Jonas is booking the offsite venue and needs to know by Friday whether you join both days.',
      body: mailBody('Jonas Holm <jonas@acme.example>', `${today}T07:41:00.000Z`, 'Hi Morten,\nwe are booking the venue for the offsite on the 14th.\nCan you confirm by Friday whether you join for both days?'),
    } },
    { at: '08:06', put: 'mail', card: {
      id: 'mail:demo:7215ee9c7d9dc229d2921a40', kind: 'decision', thread: 'thr-1781234567890123456', actions: ['archive', 'keep'],
      title: 'Re: Offsite on the 14th: are you in?',
      summary: 'The train leaves at 07:10; Jonas has seats in car 4.',
      body: mailBody('Jonas Holm <jonas@acme.example>', `${today}T08:05:00.000Z`, 'Forgot to say: the train leaves 07:10, we have seats in car 4.'),
    } },

    // --- hermes: an escalation with an editable proposal ----------------------------------------------------------
    { at: '08:14', put: 'hermes', card: {
      id: 'hermes:demo:gmail-19c3a8e05f72:reply', kind: 'decision', urgency: 'brief', thread: 'gmail-19c3a8e05f72',
      source: { url: 'https://mail.google.com/mail/u/0/#inbox/19c3a8e05f72', label: 'Gmail thread' },
      title: 'Reply to Anna re invoice timing',
      summary: 'Anna wants to pay the September invoice on the 20th instead of the 15th; Hermes proposes saying yes.',
      body: 'Anna asks whether the September invoice can be paid on the 20th instead of the 15th. Cash flow for October covers it either way.\n\n## Proposed reply\n\n> Hi Anna, the 20th is fine. Thanks for letting us know in advance.',
      actions: ['approve', 'reject', 'edit'],
    } },

    // --- caldav: a meeting moved; a decision about a later day (shown under today, marked for its day, §8 MAY) -------
    { at: '08:31', put: 'cal', card: {
      id: `cal:demo:3f9a0c1d2e4b5a69-${today.replace(/-/g, '')}T1600Z:moved`, kind: 'signal', urgency: 'immediate', thread: `day-${today}`, about: today, labels: ['calendar'],
      title: 'Moved: Call with Anna now at 16:00',
      body: '**Call with Anna** now starts at 16:00–16:30 (was 16:30).\n\nWhere: Video',
    } },
    { at: '08:40', put: 'cal', card: {
      id: `cal:demo:table-${friday}`, kind: 'decision', urgency: 'brief', about: friday, labels: ['calendar'],
      title: `Keep the table for four on ${day(friday)} at 19:00?`,
      summary: 'The restaurant holds the table until tomorrow noon; keeping it confirms the booking.',
      body: 'The restaurant holds a table for four until tomorrow noon.\n\n## Proposal\n\nKeep the table.',
      actions: [{ id: 'keep', label: 'Keep it', default: true }, { id: 'release', label: 'Release it' }],
    } },

    // --- n8n: a workflow asking for a choice ------------------------------------------------------------------------
    { at: '08:52', put: 'n8n', card: {
      id: 'n8n:demo:monitoring-db-1-disk', kind: 'decision', urgency: 'immediate', thread: 'monitoring-db-1',
      title: 'db-1 disk at 91%: what should the workflow do?',
      summary: 'db-1 will be full in about two days at the current rate; pick what the workflow does now.',
      body: 'The **db-1** data volume is at **91%** and grew 4% in the last 24 hours. At this rate it is full in about two days.\n\n```mermaid\nxychart-beta\n  title "db-1 disk used (%)"\n  x-axis [Mon, Tue, Wed, Thu, Fri, Sat, Today]\n  y-axis 0 --> 100\n  line [71, 74, 78, 80, 83, 87, 91]\n```',
      actions: [
        { id: 'expand', label: 'Grow the volume by 100 GB', body: 'Runs the **expand-volume** workflow now. About €9/month more.', default: true },
        { id: 'prune', label: 'Prune old WAL archives', body: 'Deletes WAL archives older than 14 days; frees about 60 GB.' },
        { id: 'hold', label: 'Do nothing for now' },
        'edit',
      ],
    } },

    // --- the owner decides one mail, and gives three orders; hermes and todoist carry them out ----------------------
    { at: '08:55', decide: 'mail:demo:b1946ac92492d2347c6235b4', decision: 'archive' },
    { at: '08:56', order: { to: 'hermes', title: 'Book the dentist for next week', body: `Any weekday morning; Nørrebrogade clinic.\n\n${DEMO_MARK}` }, work: {
      root: 'hermes', at: '08:58', steps: ['Found two free slots: Tue 09:00 and Thu 08:30', 'Picked Tue 09:00; booking with the clinic'],
      done: { at: '09:04', title: 'Booked the dentist for Tuesday 09:00', body: 'Booked at the Nørrebrogade clinic, **Tuesday 09:00**, with Dr. Lund. The confirmation is in your mail, and the appointment is in your calendar.' },
    } },
    { at: '08:57', order: { to: 'todoist', title: 'Renew the parking permit', body: `due: friday 9am\nForm is on the council site.\n\n${DEMO_MARK}` }, work: {
      root: 'todoist', at: '08:59', steps: ['Added to Todoist: Renew the parking permit'],
      done: { at: '09:06', title: 'Done: Renew the parking permit', body: 'Completed in Todoist.' },
    } },
    { at: '08:58', order: { to: 'hermes', title: 'Order flowers for mum’s birthday', body: `Something yellow, delivered Saturday.\n\n${DEMO_MARK}` }, work: {
      root: 'hermes', at: '09:01', steps: ['Shortlisted three florists that deliver on Saturday'], // still in progress: claimed, no outcome yet
    } },
  ];
}
