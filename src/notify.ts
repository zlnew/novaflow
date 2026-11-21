import type { Db } from "./store/db.ts";
import { loadWorkspaceConfig } from "./config.ts";

/**
 * ntfy ops-alert dispatch (novaflow-v1/architecture 3.1 Notification
 * Channel: outbound HTTPS POST, JSON payload; the halt triggers are
 * failed runs, human-intervention/gate escalations, and pipeline
 * failures — novaflow-v1/risk RSK-07). The topic is workspace config
 * ONLY (`alerts.ntfy_topic`, data.md 4.4); no topic, no alert.
 *
 * Contract: fire-and-forget with a bounded attempt. notifyHalt NEVER
 * throws — a failed notify never fails engine work. Errors are
 * swallowed into the returned result object; callers may ignore it or
 * record it in their own sink.
 *
 * Spec-silent choices (documented here, minimal-convention readings):
 *   - default base URL `https://ntfy.sh/` (the public ntfy service);
 *     injectable via opts.baseUrl.
 *   - the POST targets `<base>/<topic>` with a JSON body
 *     `{topic, title, message}` — the spec pins only "HTTPS POST, JSON
 *     payload", and ntfy accepts JSON publishing on the topic URL.
 *   - default attempt bound: 5 s (spec-silent; alerts are ops
 *     telemetry, not a control-plane dependency).
 */

export const DEFAULT_NTFY_BASE_URL = "https://ntfy.sh/";
export const DEFAULT_NOTIFY_TIMEOUT_MS = 5000;

export type HaltAlert = {
  title: string;
  message: string;
};

export type NotifyResult = {
  ok: boolean;
  topic: string;
  url?: string;
  error?: string;
};

export type PostFn = (url: string, body: string, signal: AbortSignal) => Promise<void>;

export type NotifyOptions = {
  baseUrl?: string;
  post?: PostFn;
  timeoutMs?: number;
};

async function defaultPost(url: string, body: string, signal: AbortSignal): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal,
  });
  if (!res.ok) throw new Error(`ntfy responded HTTP ${res.status}`);
}

export async function notifyHalt(
  topic: string,
  alert: HaltAlert,
  opts: NotifyOptions = {},
): Promise<NotifyResult> {
  if (typeof topic !== "string" || topic.trim() === "") {
    return { ok: false, topic: String(topic), error: "ntfy topic is empty — no alert dispatched" };
  }
  const base = (opts.baseUrl ?? DEFAULT_NTFY_BASE_URL).replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(topic)}`;
  const body = JSON.stringify({ topic, title: alert.title, message: alert.message });
  const post = opts.post ?? defaultPost;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_NOTIFY_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // bounded attempt: the race guarantees resolution even if the
    // transport never settles (a broken fetch must not pin the engine)
    await Promise.race([
      post(url, body, AbortSignal.timeout(timeoutMs)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`ntfy post did not settle within ${timeoutMs} ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
    return { ok: true, topic, url };
  } catch (err) {
    return { ok: false, topic, url, error: (err as Error).message };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A one-argument halt notifier closure — the shape engine paths take. */
export type HaltNotifier = (alert: HaltAlert) => Promise<NotifyResult>;

/**
 * Resolve the halt notifier for a task from its WORKSPACE config
 * (`alerts.ntfy_topic`). Returns null when the workspace has no topic
 * configured or the config is broken (alerts are best-effort; a broken
 * config never crashes engine work — preflight surfaces config errors
 * separately).
 */
export function taskHaltNotifier(db: Db, taskId: string, opts: NotifyOptions = {}): HaltNotifier | null {
  const row = db
    .prepare(
      `SELECT w.root_path AS root_path
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         JOIN workspaces w ON w.id = p.workspace_id
        WHERE t.id = ?`,
    )
    .get(taskId) as { root_path: string } | undefined;
  if (!row) return null;
  const load = loadWorkspaceConfig(row.root_path);
  if (!load.ok) return null;
  const topic = load.config.alerts.ntfyTopic;
  if (topic === null) return null;
  return (alert) => notifyHalt(topic, alert, opts);
}

/**
 * Fire a halt alert through a notifier without ever rejecting —
 * fire-and-forget: the returned promise resolves even when the notifier
 * itself throws (defensive; notifyHalt already never throws).
 */
export function fireHalt(notify: HaltNotifier, alert: HaltAlert): Promise<NotifyResult> {
  return Promise.resolve(notify(alert)).catch((err: unknown) => ({
    ok: false,
    topic: "",
    error: err instanceof Error ? err.message : String(err),
  }));
}
