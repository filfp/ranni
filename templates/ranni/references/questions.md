# Questions

Read this reference only when you set `waiting`, or ask the developer for a decision in
any other way.

A question must take less effort to read than it took to write. When the developer has to
dig, ask back, or rebuild what happened before they can answer, you handed them your work.

## Contents

- The Rules — what a question must carry
- Where Each Part Goes — the `waiting` line and the frontier
- Read It Cold — checking it before you leave it

## The Rules

1. **Start with what happened.** What you were doing, at whose request, and what you saw.
   Link the work item, pull request, run or test. Plain facts, in the order they happened.
2. **Ask whether it is right before asking how to fix it.** The question names what you saw
   and asks about it. Never phrase it as a choice between fixes you picked.
3. **Say why it needs the developer.** Give each reason, and mark it in the same sentence as
   seen, inferred, or a guess.
4. **Use words that are literally true.** Avoid any word that a single "what do you mean?"
   would undo, such as "broken", "ignored", "lost" or "silently".
5. **Say what the product can and cannot do here** when that limits the answer.
6. **Check what can be checked before asking.** How often it happens, what the work item,
   specs and history already say, what a quick experiment shows. Write what you found and
   what you could not find. Never hand the developer a check you could run.
7. **Give options only when they are real.** If the answer is open, ask the open question.
   When you give options, cover the realistic answers, include "Keep it as it is" when it
   applies, say what each one changes and for whom, and name any case they do not cover.
8. **Recommend only when one answer is obvious,** with its reason in one line. Otherwise
   write "No obvious recommendation."
9. **The test:** the developer can answer from the work item alone, without asking back.

## Where Each Part Goes

- `waiting`: one line, the question itself, as rule 2 says. It is what boards show first.
- The current frontier: what happened (rule 1), what the product can and cannot do
  (rule 5), why it needs the developer (rule 3), what you checked (rule 6), the options
  (rule 7) and the recommendation (rule 8).

A question asked in the conversation follows the same rules.

## Read It Cold

You know what you meant, so you cannot see where the question fails someone who does not.
When this harness offers subagents, give a fresh one only the `waiting` line and the
frontier, exactly as written, and ask what it would have to ask back before answering. Fix
what it finds and repeat once. Without subagents, reread it as the developer will, with
nothing else open.
