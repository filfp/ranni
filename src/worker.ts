import type { Config, Task, WorkerResult } from './types.js';

export const WORKER_SYSTEM_PROMPT = `You are an autonomous coding agent. Complete the task below fully and independently.
Do not ask for confirmation. Do not stop mid-task.

## Required phases — follow in order

### Phase 1: Investigate before writing any code
- Read every file relevant to the task. Search by component name, feature name, or symbol.
- Understand the full structure around the problem: layout hierarchy, data flow, navigation stack, etc.
- Identify the ROOT CAUSE — not a surface symptom. State your diagnosis explicitly before making changes.
- If you are fixing a visual/layout bug: trace the actual render tree. Know exactly which element is
  responsible for the incorrect behavior before touching any file.

### Phase 2: Apply the minimal targeted fix
- Change only what is needed to address the root cause you identified.
- Do not add defensive code for unrelated edge cases.
- Do not refactor surrounding code unless it is blocking the fix.

---

When you are done — whether successful, blocked, or errored — output the following
as the very last thing you write, with no other text after it:

<orchestrator_result>
{"status":"done|needs_help|error","summary":"one-line summary","files_changed":["relative/path"],"message":"optional longer message"}
</orchestrator_result>

Rules:
- Use "done" when the task is fully complete.
- Use "needs_help" only when you genuinely cannot proceed without information you do not have.
- Use "error" when you attempted the task and it failed.
- "files_changed" must list every file you created or modified, as paths relative to your working directory.
- "message" is required for "needs_help" and "error"; optional for "done".

---
`

function buildPrompt(task: Task): string {
  let prompt = WORKER_SYSTEM_PROMPT

  if (task.links?.length) {
    prompt += `REFERENCE LINKS (read these first — they contain the original issue description, acceptance criteria, and any screenshots):\n`
    prompt += task.links.map(l => `  - ${l}`).join('\n') + '\n\n'
  }

  if (task.relevant_files?.length) {
    prompt += `RELEVANT FILES (already identified by the manager — start your investigation here):\n`
    prompt += task.relevant_files.map(f => `  - ${f}`).join('\n') + '\n\n'
  }

  prompt += `TASK:\n${task.task}\n`
  if (task.context) prompt += `\nCONTEXT:\n${task.context}\n`
  return prompt
}

function parseResult(stdout: string, exitCode: number): WorkerResult {
  const match = stdout.match(/<orchestrator_result>\s*([\s\S]*?)\s*<\/orchestrator_result>/)
  if (!match || !match[1]) {
    return {
      status: 'error',
      summary: 'Worker exited without producing an <orchestrator_result> block',
      files_changed: [],
      message: stdout.slice(-2000),
      exit_code: exitCode
    }
  }

  try {
    const parsed = JSON.parse(match[1])
    return {
      status: parsed.status ?? 'error',
      summary: parsed.summary ?? '(no summary)',
      files_changed: Array.isArray(parsed.files_changed) ? parsed.files_changed : [],
      message: parsed.message,
      exit_code: exitCode
    }
  } catch {
    return {
      status: 'error',
      summary: 'Worker produced malformed <orchestrator_result> JSON',
      files_changed: [],
      message: match[1],
      exit_code: exitCode
    }
  }
}

export async function runWorker(task: Task, config: Config): Promise<WorkerResult> {
  const resolvedDir = config.dirs[task.dir]
  if (!resolvedDir) {
    return {
      status: 'error',
      summary: `Unknown dir key "${task.dir}" — not in .agents.yaml dirs`,
      files_changed: [],
      exit_code: 1
    }
  }

  const prompt = buildPrompt(task)

  const proc = Bun.spawn([config.worker.command, ...config.worker.args], {
    cwd: resolvedDir,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  })

  proc.stdin.write(prompt)
  proc.stdin.end()

  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])

  return parseResult(stdout, exitCode)
}
