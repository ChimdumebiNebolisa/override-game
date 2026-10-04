# OVERRIDE human playtest protocol

This protocol covers the M1 gameplay gate in the [implementation plan](IMPLEMENTATION_PLAN.md) and PRD §§40–42. It is a way to collect evidence, not a claim that a playtest has passed. Record results in a dated copy of the sections below. Keep player names and Google account details out of the notes.

## Set up

1. Record the tested commit, URL, date, browser, device, and connection type. Use a dedicated test database so `npm run report:metrics` describes only these sessions; the report aggregates all data in its database and has no date filter.
2. Recruit at least two pairs of players familiar with strategy games and one player who has never seen OVERRIDE. Use participant aliases. Ask for permission to observe and record gameplay notes.
3. Start with the default 5×5 board, four starting nodes per side, 12 standard rounds, 5-second decisions, and current Energy costs. Change one allowed balance variable only after reviewing the baseline evidence.
4. Have two devices ready for each human match. Keep the moderator out of move selection and avoid explaining rules beyond what the game shows during the first match.

## Sessions

1. Give the new player the link. Ask them to choose Practice or Quick Duel vs Bot, play to a result, and decide whether to rematch. Note where they hesitate, use hints, misunderstand an outcome, or need help. Ask them to explain Expand, Ambush, Energy, and the result in their own words afterward.
2. Have each competent pair create and join a Quick Duel friend room on separate devices. Let them finish a match without coaching. Leave the result screen visible and record whether either player **voluntarily** requests a rematch before asking about it. If they do, play the rematch and check that starting sides swap.
3. After normal play, test refresh and a brief connection interruption in a separate match. Record whether the current round keeps its fixed deadline, reconnect restores the correct state, and both players see the same reveal. Keep this recovery check separate from the unprompted rematch observation.
4. Ask players about prediction choices, collisions, 5-second timing, the fixed reveal wait, comeback chances, repetitive openings, and why they won or lost. Ask whether Pass ever felt strategic. Record concrete examples and round numbers, not just a yes/no answer.

## Session record

| Field | Observation |
| --- | --- |
| Tested commit, URL, date | |
| Participant aliases and experience | |
| Mode, bot difficulty if applicable, devices | |
| Match IDs and starting sides | |
| Completed? Result, round count, final territory | |
| Ambush attempts and successful hits | |
| Meaningful Surge, Override, and Pass choices | |
| Collisions or rounds where neither side gained territory | |
| First neutral-board exhaustion, if observed | |
| Early lead and whether the trailing player recovered | |
| Confusing action or outcome, with round number | |
| Time pressure or fixed reveal feedback | |
| Voluntary rematch requested before prompting? By whom? | |
| Refresh or interruption outcome, if tested | |

## Review the evidence

Set `DB_PATH` to the dedicated test database, run `npm run report:metrics`, and save its JSON with the session notes. Review completion, action mix, voluntary and automatic Pass, Ambush attempts and hits, Surge and Override usage, match length, board-exhaustion endings, final score differences, rematches **by mode**, and side results **by human or bot category**. Use the session notes for collision frequency, early-lead recoveries, neutral exhaustion timing, and comprehension; the aggregate report does not calculate those directly. Do not treat bot side results as evidence of human side balance.

Record a **go / tune / stop** decision with the number of human matches, observed voluntary rematches, main comprehension failures, and the strongest balance evidence. The PRD sets no numeric pass threshold. If tuning is needed, state the single variable changed, its old and new values, and the next playtest date. Do not replace human rematch evidence with bot simulations or local test traffic.

## Decision record

**Date and tested commit:**

**Participants and completed matches:**

**Voluntary human rematches:**

**What players understood / did not understand:**

**Action and balance observations:**

**Recovery observations:**

**Decision (go / tune / stop) and reason:**

**Allowed balance change and retest, if any:**
